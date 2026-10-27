#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
mkdir -p public
cp index.html style.css script.js public/
cp logo.svg public/logo.svg
printf '%s\n' 'Public app files updated. The local AI API is served by echo_ai_server.py, not copied into public/.'
