#!/bin/sh
set -e
cd "$(dirname "$0")"
exec python3 server.py --host 0.0.0.0 --port 8000 --max-peers 8
