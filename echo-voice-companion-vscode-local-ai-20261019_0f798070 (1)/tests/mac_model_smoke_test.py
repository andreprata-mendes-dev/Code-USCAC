#!/usr/bin/env python3
"""Manually exercise real MLX inference on a consented local WAV sample."""
from __future__ import annotations

import base64
import io
import platform
import sys
import tempfile
import uuid
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import echo_ai_server as server  # noqa: E402


def main() -> int:
    if sys.platform != "darwin" or platform.machine().lower() not in {"arm64", "aarch64"}:
        print("This smoke test requires native Apple Silicon macOS.", file=sys.stderr)
        return 2
    if sys.version_info[:2] != (3, 12):
        print("Use the project's Python 3.12 virtual environment: .venv/bin/python", file=sys.stderr)
        return 2

    permission = input("Are you the speaker or do you have the speaker's explicit permission? Type YES to continue: ").strip()
    if permission != "YES":
        print("No audio was processed. Obtain explicit permission before testing.")
        return 2

    reference_input = input("Path to a local WAV recording (up to 30 seconds): ").strip().strip('"')
    reference_path = Path(reference_input).expanduser()
    if not reference_path.is_file():
        print("The selected local recording was not found.", file=sys.stderr)
        return 2

    transcript = input("Type the exact words spoken in that recording: ").strip()
    text = input("Sentence to generate (up to 500 characters): ").strip()
    language = input("Language [english/spanish/french/german/chinese/italian/japanese] (default english): ").strip().lower() or "english"
    if language not in server.ALLOWED_LANGUAGES:
        print("That language is not supported by the pinned local model.", file=sys.stderr)
        return 2

    try:
        from mlx_audio.audio_io import read as read_audio, write as write_audio

        with tempfile.TemporaryDirectory(prefix="echo-smoke-input-") as temp_name:
            normalized_path = Path(temp_name) / "consented-reference.wav"
            audio, sample_rate = read_audio(
                reference_path,
                dtype="float32",
                sample_rate=24000,
                nchannels=1,
                duration=30,
            )
            write_audio(str(normalized_path), audio, sample_rate, format="wav")
            reference_bytes = normalized_path.read_bytes()
            if len(reference_bytes) > server.MAX_AUDIO_BYTES:
                raise ValueError("The normalized recording exceeds the 5 MB limit.")

            request = server.validate_payload({
                "consent": True,
                "requestId": str(uuid.uuid4()),
                "audioBase64": base64.b64encode(reference_bytes).decode("ascii"),
                "transcript": transcript,
                "text": text,
                "language": language,
            })
            wav_bytes = server.synthesize_wav(request)

        with wave.open(io.BytesIO(wav_bytes), "rb") as generated:
            if generated.getnframes() <= 0 or generated.getframerate() <= 0:
                raise RuntimeError("The model returned an empty WAV stream.")

        cache = getattr(server._MODEL, "_icl_cache", None)
        if not isinstance(cache, dict) or cache:
            raise RuntimeError("The pinned Qwen reference cache was not cleared after generation.")
        print("Real MLX inference succeeded. The output was a valid WAV and the reference cache was cleared.")
        print("The test did not save the generated speech; temporary files were removed automatically.")
        return 0
    except Exception as error:
        print(f"Local model smoke test failed ({type(error).__name__}). Review setup, then retry.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
