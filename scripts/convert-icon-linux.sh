#!/usr/bin/env bash
set -euo pipefail

mkdir -p build

IM_CMD=""
if command -v magick &> /dev/null; then
  IM_CMD=magick
elif command -v convert &> /dev/null; then
  IM_CMD=convert
else
  sudo apt-get update -qq
  sudo apt-get install -y imagemagick
  if command -v magick &> /dev/null; then
    IM_CMD=magick
  elif command -v convert &> /dev/null; then
    IM_CMD=convert
  fi
fi

if [ -z "$IM_CMD" ]; then
  echo "ImageMagick not available (magick/convert missing after install)"
  exit 1
fi

echo "Using ImageMagick command: $IM_CMD"
"$IM_CMD" frontend/public/zzz.png -resize 256x256! build/icon.png

if command -v magick &> /dev/null; then
  magick identify -format '%wx%h' build/icon.png | grep -E '^256x256$' || {
    echo "icon.png must be exactly 256x256"
    exit 1
  }
else
  identify -format '%wx%h' build/icon.png | grep -E '^256x256$' || {
    echo "icon.png must be exactly 256x256"
    exit 1
  }
fi
