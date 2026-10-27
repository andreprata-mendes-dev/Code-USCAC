#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'Local AI voice generation requires macOS on Apple Silicon. The browser app can still run, but MLX inference cannot run on this system.' >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  printf '%s\n' 'This model requires Apple Silicon running native arm64 Python. If this is an M-series Mac, open Terminal without Rosetta and retry.' >&2
  exit 1
fi
if ! command -v python3.12 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3.12 was not found. Install it with: brew install python@3.12' >&2
  exit 1
fi

python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-local-ai.txt
.venv/bin/python - <<'PY'
import platform
import sys
from importlib.metadata import version
import mlx
import mlx_audio
from mlx_audio.audio_io import write as write_audio
from mlx_audio.tts.utils import load_model

assert sys.version_info[:2] == (3, 12), f"Expected Python 3.12, found {sys.version.split()[0]}"
assert platform.machine().lower() in {"arm64", "aarch64"}, "Native Apple Silicon Python is required"
assert version("mlx-audio") == "0.6.0", f"Expected mlx-audio 0.6.0, found {version('mlx-audio')}"
assert callable(write_audio) and callable(load_model)
print("Local voice environment ready: native Apple Silicon, Python 3.12, MLX, and mlx-audio 0.6.0.")
print("Model weights are not downloaded by setup. The first generation downloads them from Hugging Face.")
PY
