#!/usr/bin/env bash
set -euo pipefail

# Render build script ensures dependencies are installed using pip from the project root.
cd "$(dirname "$0")"

python -m pip install --upgrade pip
pip install --no-cache-dir -r requirements.txt
