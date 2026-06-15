#!/bin/bash
set -e

echo "=== Installing dependencies ==="
pip3 install openai-whisper imageio-ffmpeg

echo ""
echo "=== Done! ==="
echo ""
echo "Usage:"
echo "  python3 transcribe.py video.mp4"
echo "  python3 transcribe.py video.mp4 large"
echo ""
echo "First run will download the Whisper model (~1.5 GB for 'medium')."
