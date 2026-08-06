#!/bin/bash
set -e

echo "=== Устанавливаю зависимости ==="
pip3 install openai-whisper imageio-ffmpeg yt-dlp

echo ""
echo "=== Готово! ==="
echo ""
echo "Использование:"
echo "  python3 transcribe.py video.mp4"
echo "  python3 transcribe.py https://youtube.com/watch?v=..."
echo "  python3 transcribe.py https://mts-link.ru/record/..."
echo ""
echo "При первом запуске скачается модель Whisper (~1.5 ГБ)."
