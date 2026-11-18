#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_DIR/.venv-media"

echo "=== Tự Học Nghe – Nói — Thiết lập & Tạo Audio MP3 + Video MP4 ==="

if [ ! -d "$VENV_DIR" ]; then
  echo "[1/3] Tạo môi trường Python tại $VENV_DIR ..."
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV_DIR"
    uv pip install --python "$VENV_DIR/bin/python" edge-tts
  else
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --upgrade pip edge-tts
  fi
fi

if [ ! -x "$SCRIPT_DIR/render_video" ] || [ "$SCRIPT_DIR/render_video.swift" -nt "$SCRIPT_DIR/render_video" ]; then
  echo "[2/3] Biên dịch trình dựng video gốc macOS (Swift AVFoundation)..."
  swiftc -O -module-cache-path /tmp/swift_modcache \
    "$SCRIPT_DIR/render_video.swift" -o "$SCRIPT_DIR/render_video"
fi

echo "[3/3] Chạy tạo Audio (MP3) & Video (MP4)..."
if [ "${1:-}" = "all" ]; then
  "$VENV_DIR/bin/python" "$SCRIPT_DIR/generate_media.py" --all
elif [ $# -ge 1 ]; then
  "$VENV_DIR/bin/python" "$SCRIPT_DIR/generate_media.py" --chapters "$@"
else
  "$VENV_DIR/bin/python" "$SCRIPT_DIR/generate_media.py" --chapters 1
fi

echo "Hoàn tất! Bạn có thể mở Slide-Tuong-Tac/index.html để học hoặc xem video trong Media-Video/."
