#!/usr/bin/env python3
"""Serve Echo and local-only Qwen3-TTS inference on this computer's loopback."""
from __future__ import annotations

import base64
import binascii
import contextlib
import gc
import importlib.metadata
import importlib.util
import json
import os
import platform
import re
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit"
MLX_AUDIO_VERSION = "0.6.0"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
ALLOWED_LANGUAGES = {
    "english", "spanish", "french", "german", "chinese", "italian", "japanese"
}
MAX_AUDIO_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 500
MAX_TRANSCRIPT_CHARS = 800
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 40 * 1024 * 1024
REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,80}\Z")
PENDING_CANCEL_TTL_SECONDS = 60
MAX_PENDING_CANCELLATIONS = 64
_MODEL = None
_MODEL_LOCK = threading.Lock()
_GENERATION_LOCK = threading.Lock()
_ACTIVE_GENERATIONS: dict[str, threading.Event] = {}
_PENDING_CANCELLATIONS: dict[str, float] = {}


class RequestProblem(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class GenerationCancelled(Exception):
    """Raised after local inference when a client has withdrawn its request."""


def is_apple_silicon_mac() -> bool:
    return sys.platform == "darwin" and platform.machine().lower() in {"arm64", "aarch64"}


def runtime_status() -> dict:
    if not is_apple_silicon_mac():
        return {
            "available": False,
            "message": "On-device AI voice generation needs an Apple Silicon Mac (M-series). The web app still runs here, but this MLX model cannot run on Intel Macs or other operating systems.",
            "modelId": MODEL_ID,
        }
    if sys.version_info[:2] != (3, 12):
        return {
            "available": False,
            "message": "Local AI needs native Python 3.12. In VS Code's terminal run ./setup-local-ai.sh, then restart the app.",
            "modelId": MODEL_ID,
        }
    try:
        missing = [name for name in ("mlx", "mlx_audio") if importlib.util.find_spec(name) is None]
    except (ImportError, ValueError):
        missing = ["mlx / mlx-audio"]
    if missing:
        return {
            "available": False,
            "message": "Local AI packages are not installed. In VS Code's terminal run ./setup-local-ai.sh, then restart the app.",
            "modelId": MODEL_ID,
        }
    try:
        installed_version = importlib.metadata.version("mlx-audio")
    except importlib.metadata.PackageNotFoundError:
        installed_version = "missing"
    if installed_version != MLX_AUDIO_VERSION:
        return {
            "available": False,
            "message": f"Local AI needs the pinned mlx-audio {MLX_AUDIO_VERSION} package. Run ./setup-local-ai.sh, then restart the app.",
            "modelId": MODEL_ID,
        }
    return {
        "available": True,
        "message": "Local AI is ready. The first generation downloads about 2.6 GB of model files to this Mac; your recording and text are not sent with that download.",
        "modelId": MODEL_ID,
        "modelLoaded": _MODEL is not None,
    }


def _validate_request_id(value: object) -> str:
    if not isinstance(value, str) or not REQUEST_ID_PATTERN.fullmatch(value):
        raise RequestProblem("The local generation request ID is missing or invalid.")
    return value


def validate_payload(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise RequestProblem("The request body must be a JSON object.")
    if payload.get("consent") is not True:
        raise RequestProblem("Confirm the speaker's permission before generating speech.", 403)

    request_id = _validate_request_id(payload.get("requestId"))
    text = payload.get("text")
    transcript = payload.get("transcript")
    language = payload.get("language")
    audio_base64 = payload.get("audioBase64")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        raise RequestProblem(f"Enter text to speak (up to {MAX_TEXT_CHARS} characters).")
    if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > MAX_TRANSCRIPT_CHARS:
        raise RequestProblem(f"Enter the exact words in the recording (up to {MAX_TRANSCRIPT_CHARS} characters).")
    if not isinstance(language, str) or language.lower() not in ALLOWED_LANGUAGES:
        raise RequestProblem("This model does not support the selected speech language.")
    if not isinstance(audio_base64, str) or len(audio_base64) > ((MAX_AUDIO_BYTES + 2) // 3) * 4 + 8:
        raise RequestProblem("The local reference recording exceeds the 5 MB limit.", 413)
    try:
        audio_bytes = base64.b64decode(audio_base64, validate=True)
    except (binascii.Error, ValueError):
        raise RequestProblem("The reference recording could not be decoded as audio.") from None
    if len(audio_bytes) < 44 or len(audio_bytes) > MAX_AUDIO_BYTES:
        raise RequestProblem("The WAV reference recording must be between 44 bytes and 5 MB.", 413)
    if audio_bytes[:4] != b"RIFF" or audio_bytes[8:12] != b"WAVE":
        raise RequestProblem("The reference recording must be a browser-converted WAV file.")
    return {
        "request_id": request_id,
        "text": text.strip(),
        "transcript": transcript.strip(),
        "language": language.lower(),
        "audio": audio_bytes,
    }


def _prune_pending_cancellations(now: float) -> None:
    expired = [
        request_id for request_id, created_at in _PENDING_CANCELLATIONS.items()
        if now - created_at > PENDING_CANCEL_TTL_SECONDS
    ]
    for request_id in expired:
        _PENDING_CANCELLATIONS.pop(request_id, None)
    while len(_PENDING_CANCELLATIONS) > MAX_PENDING_CANCELLATIONS:
        oldest = next(iter(_PENDING_CANCELLATIONS))
        _PENDING_CANCELLATIONS.pop(oldest, None)


def _register_generation(request_id: str) -> threading.Event:
    with _GENERATION_LOCK:
        _prune_pending_cancellations(time.monotonic())
        if request_id in _ACTIVE_GENERATIONS:
            raise RequestProblem("This generation request is already active.", 409)
        cancel_event = threading.Event()
        if request_id in _PENDING_CANCELLATIONS:
            cancel_event.set()
            _PENDING_CANCELLATIONS.pop(request_id, None)
        _ACTIVE_GENERATIONS[request_id] = cancel_event
        return cancel_event


def request_generation_cancellation(request_id: str) -> bool:
    with _GENERATION_LOCK:
        now = time.monotonic()
        _prune_pending_cancellations(now)
        active = _ACTIVE_GENERATIONS.get(request_id)
        if active is not None:
            active.set()
            return True
        _PENDING_CANCELLATIONS[request_id] = now
        _prune_pending_cancellations(now)
        return False


def _finish_generation(request_id: str) -> None:
    with _GENERATION_LOCK:
        _ACTIVE_GENERATIONS.pop(request_id, None)


def _load_model():
    global _MODEL
    if _MODEL is None:
        from mlx_audio.tts.utils import load_model

        _MODEL = load_model(MODEL_ID)
    return _MODEL


def _clear_reference_state(model) -> None:
    """Clear the reference-code cache exposed by the pinned mlx-audio release."""
    cache = getattr(model, "_icl_cache", None)
    if not isinstance(cache, dict):
        raise RuntimeError("The pinned MLX-Audio reference cache is unavailable; refusing to retain reference state.")
    cache.clear()
    import mlx.core as mx

    mx.clear_cache()
    gc.collect()


def synthesize_wav(request: dict, cancel_event: threading.Event | None = None) -> bytes:
    """Run one local inference, clear reference state, and return a temporary WAV."""
    if not is_apple_silicon_mac():
        raise RequestProblem(runtime_status()["message"], 503)
    status = runtime_status()
    if not status["available"]:
        raise RequestProblem(status["message"], 503)
    if cancel_event is not None and cancel_event.is_set():
        raise GenerationCancelled

    from mlx_audio.audio_io import write as audio_write
    import mlx.core as mx

    with tempfile.TemporaryDirectory(prefix="echo-local-voice-") as temp_name:
        temp = Path(temp_name)
        reference_path = temp / "reference.wav"
        output_path = temp / "echo-generated.wav"
        reference_path.write_bytes(request["audio"])
        request["audio"] = b""

        with _MODEL_LOCK:
            if cancel_event is not None and cancel_event.is_set():
                raise GenerationCancelled
            model = _load_model()
            try:
                if cancel_event is not None and cancel_event.is_set():
                    raise GenerationCancelled
                # The package's convenience generate_audio helper prints target text.
                # Use the documented model API directly and suppress library diagnostics.
                with open(os.devnull, "w", encoding="utf-8") as quiet_output:
                    with contextlib.redirect_stdout(quiet_output), contextlib.redirect_stderr(quiet_output):
                        generated = model.generate(
                            text=request["text"],
                            lang_code=request["language"],
                            ref_audio=str(reference_path),
                            ref_text=request["transcript"],
                            verbose=False,
                        )
                        chunks = list(generated)
                        del generated
                        if cancel_event is not None and cancel_event.is_set():
                            raise GenerationCancelled
                        if not chunks:
                            raise RuntimeError("The local model returned no speech chunks.")
                        audio = chunks[0].audio if len(chunks) == 1 else mx.concatenate(
                            [chunk.audio for chunk in chunks], axis=0
                        )
                        audio_write(str(output_path), audio, model.sample_rate, format="wav")
                        del audio, chunks
            finally:
                _clear_reference_state(model)

        if cancel_event is not None and cancel_event.is_set():
            raise GenerationCancelled
        if not output_path.is_file():
            raise RuntimeError("The local model did not produce its WAV output.")
        if output_path.stat().st_size > MAX_OUTPUT_BYTES:
            raise RequestProblem("Generated audio exceeded the 40 MB safety limit.", 413)
        result = output_path.read_bytes()
        if result[:4] != b"RIFF" or result[8:12] != b"WAVE":
            raise RuntimeError("The local model output was not a WAV file.")
        return result


class EchoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, "Directory listing is disabled")
        return None

    def log_message(self, _format, *args):
        # Never log request bodies, transcripts, audio, or query strings.
        return

    def _json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _check_local_post(self) -> bool:
        host_header = self.headers.get("Host", "")
        host = host_header.split(":", 1)[0].strip("[]").lower()
        if host not in {"127.0.0.1", "localhost"}:
            self._json(403, {"error": "This local service accepts loopback requests only."})
            return False
        if self.headers.get("Origin") != f"http://{host_header}":
            self._json(403, {"error": "The request must come from this local Echo page."})
            return False
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "Send a JSON request from the local Echo page."})
            return False
        return True

    def _read_json_body(self, max_bytes: int) -> object:
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > max_bytes:
            raise RequestProblem("The request is missing a length or exceeds the local size limit.", 413)
        try:
            body = self.rfile.read(length)
            payload = json.loads(body.decode("utf-8"))
            del body
            return payload
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RequestProblem("The request body was not valid UTF-8 JSON.") from None

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/health":
            self._json(200, runtime_status())
            return
        if path.startswith("/api/"):
            self._json(404, {"error": "Local API route not found."})
            return
        super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path not in {"/api/voice/generate", "/api/voice/cancel"}:
            self._json(404, {"error": "Local API route not found."})
            return
        if not self._check_local_post():
            return

        try:
            if path == "/api/voice/cancel":
                payload = self._read_json_body(1024)
                if not isinstance(payload, dict):
                    raise RequestProblem("The cancellation body must be a JSON object.")
                request_id = _validate_request_id(payload.get("requestId"))
                active = request_generation_cancellation(request_id)
                self._json(202, {"accepted": True, "active": active})
                return

            payload = self._read_json_body(MAX_BODY_BYTES)
            request = validate_payload(payload)
            del payload
            request_id = request["request_id"]
            cancel_event = _register_generation(request_id)
            try:
                audio = synthesize_wav(request, cancel_event)
            except GenerationCancelled:
                return
            finally:
                _finish_generation(request_id)
                request["audio"] = b""
                request["text"] = ""
                request["transcript"] = ""

        except RequestProblem as error:
            self._json(error.status, {"error": str(error)})
            return
        except Exception as error:  # Do not echo private audio/text or library internals.
            print(f"[Echo] Local inference failed ({type(error).__name__}); request data was not logged.", file=sys.stderr)
            self._json(500, {"error": "The local model could not generate audio. Check the terminal for a private-data-free error summary, then try again."})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(audio)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            del audio


def main():
    if not PUBLIC.is_dir() or not (PUBLIC / "index.html").is_file():
        raise SystemExit("The public/ folder is missing. Run ./build.sh first.")
    server = None
    for port in range(3000, 3011):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), EchoHandler)
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("No free port from 3000 through 3010. Stop another local server and try again.")
    server.daemon_threads = True
    port = server.server_address[1]
    print(f"Echo is running at http://127.0.0.1:{port}")
    print("This server is bound to this Mac only. It never logs audio, transcripts, or generated text.")
    print("Press Control+C to stop it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEcho stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
