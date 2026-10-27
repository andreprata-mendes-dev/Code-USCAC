import base64
import contextlib
import http.client
import importlib.util
import io
import json
import struct
import sys
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("echo_ai_server", ROOT / "echo_ai_server.py")
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


def tiny_wav_bytes():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(struct.pack("<h", 0) * 240)
    return buffer.getvalue()


def valid_payload():
    return {
        "consent": True,
        "requestId": "test-request-123",
        "audioBase64": base64.b64encode(tiny_wav_bytes()).decode("ascii"),
        "transcript": "This is a private reference transcript.",
        "text": "This is a private generated sentence.",
        "language": "english",
    }


class RequestValidationTests(unittest.TestCase):
    def test_valid_request_is_normalized_without_changing_text(self):
        result = server.validate_payload(valid_payload())
        self.assertEqual(result["text"], "This is a private generated sentence.")
        self.assertEqual(result["transcript"], "This is a private reference transcript.")
        self.assertEqual(result["language"], "english")
        self.assertEqual(result["request_id"], "test-request-123")
        self.assertTrue(result["audio"].startswith(b"RIFF"))

    def test_missing_ai_consent_is_rejected(self):
        payload = valid_payload()
        payload["consent"] = False
        with self.assertRaises(server.RequestProblem) as error:
            server.validate_payload(payload)
        self.assertEqual(error.exception.status, 403)

    def test_request_id_is_required_and_bounded(self):
        for request_id in (None, "short", "bad id with spaces", "x" * 81):
            with self.subTest(request_id=request_id):
                payload = valid_payload()
                payload["requestId"] = request_id
                with self.assertRaises(server.RequestProblem):
                    server.validate_payload(payload)

    def test_missing_exact_transcript_is_rejected(self):
        payload = valid_payload()
        payload["transcript"] = "  "
        with self.assertRaises(server.RequestProblem):
            server.validate_payload(payload)

    def test_each_supported_language_is_accepted(self):
        for language in sorted(server.ALLOWED_LANGUAGES):
            with self.subTest(language=language):
                payload = valid_payload()
                payload["language"] = language
                self.assertEqual(server.validate_payload(payload)["language"], language)

    def test_unsupported_language_is_rejected(self):
        payload = valid_payload()
        payload["language"] = "tagalog"
        with self.assertRaises(server.RequestProblem):
            server.validate_payload(payload)

    def test_invalid_base64_is_rejected(self):
        payload = valid_payload()
        payload["audioBase64"] = "not base64!"
        with self.assertRaises(server.RequestProblem):
            server.validate_payload(payload)

    def test_non_wav_audio_is_rejected(self):
        payload = valid_payload()
        payload["audioBase64"] = base64.b64encode(b"not a wav recording").decode("ascii")
        with self.assertRaises(server.RequestProblem):
            server.validate_payload(payload)


class RuntimeCompatibilityTests(unittest.TestCase):
    def test_wrong_python_version_disables_local_model_with_setup_guidance(self):
        with (
            mock.patch.object(server, "is_apple_silicon_mac", return_value=True),
            mock.patch.object(server.sys, "version_info", (3, 13, 0)),
        ):
            status = server.runtime_status()
        self.assertFalse(status["available"])
        self.assertIn("Python 3.12", status["message"])


class ModelLoadingTests(unittest.TestCase):
    def _install_fake_loader(self, loader):
        fake_utils = types.ModuleType("mlx_audio.tts.utils")
        fake_utils.load_model = loader
        fake_tts = types.ModuleType("mlx_audio.tts")
        fake_tts.__path__ = []
        fake_audio = types.ModuleType("mlx_audio")
        fake_audio.__path__ = []
        return mock.patch.dict(sys.modules, {
            "mlx_audio": fake_audio,
            "mlx_audio.tts": fake_tts,
            "mlx_audio.tts.utils": fake_utils,
        })

    def test_model_is_loaded_lazily_once_and_reused(self):
        loaded_ids = []
        fake_model = object()

        def loader(model_id):
            loaded_ids.append(model_id)
            return fake_model

        previous_model = server._MODEL
        server._MODEL = None
        try:
            with self._install_fake_loader(loader):
                self.assertIs(server._load_model(), fake_model)
                self.assertIs(server._load_model(), fake_model)
            self.assertEqual(loaded_ids, [server.MODEL_ID])
        finally:
            server._MODEL = previous_model

    def test_model_load_failure_propagates_without_caching_a_partial_model(self):
        def loader(_model_id):
            raise RuntimeError("model load failed")

        previous_model = server._MODEL
        server._MODEL = None
        try:
            with self._install_fake_loader(loader):
                with self.assertRaisesRegex(RuntimeError, "model load failed"):
                    server._load_model()
            self.assertIsNone(server._MODEL)
        finally:
            server._MODEL = previous_model


class MockedInferenceTests(unittest.TestCase):
    def _fake_runtime(self, cancel_event=None, fail=False):
        calls = {}
        expected_wav = tiny_wav_bytes()
        cleared_cache = mock.Mock()

        class FakeModel:
            sample_rate = 24000

            def __init__(self):
                self._icl_cache = {("previous transcript", "reference fingerprint"): ("codes", "tokens")}

            def generate(self, **kwargs):
                calls.update(kwargs)
                calls["reference_existed_during_generation"] = Path(kwargs["ref_audio"]).is_file()
                self._icl_cache[(kwargs["ref_text"], "current request")] = ("private codes", "private tokens")
                print(kwargs["text"])
                print(kwargs["ref_text"], file=sys.stderr)
                if cancel_event is not None:
                    cancel_event.set()
                if fail:
                    raise RuntimeError("private generation failure")
                return iter([types.SimpleNamespace(audio=b"fake audio samples")])

        fake_model = FakeModel()
        fake_audio_io = types.ModuleType("mlx_audio.audio_io")

        def write_fake_audio(path, audio, sample_rate, format):
            calls["written_path"] = path
            calls["written_audio"] = audio
            calls["written_sample_rate"] = sample_rate
            calls["written_format"] = format
            Path(path).write_bytes(expected_wav)

        fake_audio_io.write = write_fake_audio
        fake_mlx = types.ModuleType("mlx")
        fake_mlx.__path__ = []
        fake_core = types.ModuleType("mlx.core")
        fake_core.clear_cache = cleared_cache
        fake_core.concatenate = lambda values, axis=0: b"joined samples"
        fake_mlx.core = fake_core
        modules = {
            "mlx": fake_mlx,
            "mlx.core": fake_core,
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.audio_io": fake_audio_io,
        }
        modules["mlx_audio"].__path__ = []
        patches = (
            mock.patch.dict(sys.modules, modules),
            mock.patch.object(server, "is_apple_silicon_mac", return_value=True),
            mock.patch.object(server, "runtime_status", return_value={"available": True}),
            mock.patch.object(server, "_load_model", return_value=fake_model),
        )
        return calls, expected_wav, cleared_cache, fake_model, patches

    def test_direct_model_api_returns_wav_and_clears_reference_state_without_logging_text(self):
        calls, expected_wav, cleared_cache, fake_model, patches = self._fake_runtime()
        request = server.validate_payload(valid_payload())
        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()
        with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
            with patches[0], patches[1], patches[2], patches[3]:
                result = server.synthesize_wav(request)

        self.assertEqual(result, expected_wav)
        self.assertEqual(calls["text"], "This is a private generated sentence.")
        self.assertEqual(calls["ref_text"], "This is a private reference transcript.")
        self.assertEqual(calls["lang_code"], "english")
        self.assertTrue(calls["reference_existed_during_generation"])
        self.assertEqual(calls["written_sample_rate"], 24000)
        self.assertEqual(calls["written_format"], "wav")
        self.assertEqual(Path(calls["written_path"]).name, "echo-generated.wav")
        self.assertFalse(Path(calls["ref_audio"]).exists(), "temporary reference audio must be removed")
        self.assertEqual(fake_model._icl_cache, {}, "reference codes and transcript tokens must be evicted")
        cleared_cache.assert_called_once()
        self.assertNotIn("This is a private generated sentence.", captured_stdout.getvalue())
        self.assertNotIn("This is a private reference transcript.", captured_stdout.getvalue())
        self.assertNotIn("This is a private reference transcript.", captured_stderr.getvalue())

    def test_canceled_generation_suppresses_output_and_clears_reference_state(self):
        cancel_event = threading.Event()
        calls, _expected_wav, cleared_cache, fake_model, patches = self._fake_runtime(cancel_event=cancel_event)
        request = server.validate_payload(valid_payload())
        with (
            patches[0], patches[1], patches[2], patches[3],
            self.assertRaises(server.GenerationCancelled),
        ):
            server.synthesize_wav(request, cancel_event)

        self.assertFalse(Path(calls["ref_audio"]).exists(), "temporary reference audio must be removed after cancellation")
        self.assertEqual(fake_model._icl_cache, {}, "reference cache must be cleared after cancellation")
        cleared_cache.assert_called_once()
        self.assertNotIn("written_path", calls, "canceled output must not be written")

    def test_generation_failure_still_clears_reference_state(self):
        calls, _expected_wav, cleared_cache, fake_model, patches = self._fake_runtime(fail=True)
        request = server.validate_payload(valid_payload())
        with (
            patches[0], patches[1], patches[2], patches[3],
            self.assertRaises(RuntimeError),
        ):
            server.synthesize_wav(request)

        self.assertFalse(Path(calls["ref_audio"]).exists())
        self.assertEqual(fake_model._icl_cache, {})
        cleared_cache.assert_called_once()


class CancellationRegistryTests(unittest.TestCase):
    def setUp(self):
        server._ACTIVE_GENERATIONS.clear()
        server._PENDING_CANCELLATIONS.clear()

    def tearDown(self):
        server._ACTIVE_GENERATIONS.clear()
        server._PENDING_CANCELLATIONS.clear()

    def test_active_request_can_be_marked_cancelled(self):
        request_id = "cancel-request-1"
        event = server._register_generation(request_id)
        self.assertTrue(server.request_generation_cancellation(request_id))
        self.assertTrue(event.is_set())
        server._finish_generation(request_id)
        self.assertNotIn(request_id, server._ACTIVE_GENERATIONS)

    def test_cancel_before_registration_is_remembered_for_short_race(self):
        request_id = "cancel-race-123"
        self.assertFalse(server.request_generation_cancellation(request_id))
        event = server._register_generation(request_id)
        self.assertTrue(event.is_set())
        server._finish_generation(request_id)


class LocalHttpTests(unittest.TestCase):
    def setUp(self):
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.EchoHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def _request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        status = response.status
        data = response.read()
        connection.close()
        return status, data

    def test_health_endpoint_reports_mlx_unavailable_outside_apple_silicon_macos(self):
        status, body = self._request("GET", "/api/health")
        result = json.loads(body)
        self.assertEqual(status, 200)
        self.assertFalse(result["available"])
        self.assertIn("Apple Silicon Mac", result["message"])

    def test_local_server_serves_the_static_echo_page(self):
        status, body = self._request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Echo", body)

    def test_generation_requires_explicit_consent_from_the_local_page(self):
        payload = valid_payload()
        payload["consent"] = False
        status, body = self._request(
            "POST",
            "/api/voice/generate",
            body=json.dumps(payload),
            headers={"Origin": self.origin, "Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)
        self.assertNotIn(b"This is a private generated sentence.", body)

    def test_generation_rejects_a_non_local_origin(self):
        payload = valid_payload()
        status, _body = self._request(
            "POST",
            "/api/voice/generate",
            body=json.dumps(payload),
            headers={"Origin": "https://attacker.example", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
