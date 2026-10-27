#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ -x .venv/bin/python ]; then
  PYTHON=.venv/bin/python
elif command -v python3.12 >/dev/null 2>&1; then
  PYTHON=python3.12
elif command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
else
  printf '%s\n' 'Python 3 was not found. Install Python 3.12 for local AI with: brew install python@3.12' >&2
  exit 1
fi

PYTHON_VERSION=$("$PYTHON" -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
if [ "$PYTHON_VERSION" != "3.12" ]; then
  printf '%s\n' "Warning: $PYTHON is Python $PYTHON_VERSION; local MLX voice generation requires Python 3.12. Run ./setup-local-ai.sh for the supported environment." >&2
fi

exec "$PYTHON" echo_ai_server.py
