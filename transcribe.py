#!/usr/bin/env python3
import sys
import os
import tempfile
import subprocess


def get_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return "ffmpeg"
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found. Run: pip3 install imageio-ffmpeg")


def extract_audio(video_path, ffmpeg_bin):
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    result = subprocess.run(
        [
            ffmpeg_bin, "-y", "-i", video_path,
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            tmp.name,
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        os.unlink(tmp.name)
        sys.exit(f"ffmpeg error:\n{result.stderr.decode()}")
    return tmp.name


def transcribe(video_path, model_name="medium", language="ru"):
    try:
        import whisper
    except ImportError:
        sys.exit("whisper not installed. Run: pip3 install openai-whisper")

    ffmpeg_bin = get_ffmpeg()

    print(f"Extracting audio from: {os.path.basename(video_path)}")
    audio_path = extract_audio(video_path, ffmpeg_bin)

    try:
        print(f"Loading Whisper model '{model_name}' (first run: download ~1.5 GB)...")
        model = whisper.load_model(model_name)

        print("Transcribing...")
        result = model.transcribe(audio_path, language=language)
        text = result["text"].strip()
    finally:
        os.unlink(audio_path)

    output_path = os.path.splitext(video_path)[0] + ".txt"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text)

    print(f"\nDone! Saved to: {output_path}\n")
    print("--- Preview (first 500 chars) ---")
    print(text[:500])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 transcribe.py <video_file> [model] [language]")
        print()
        print("Models (quality vs speed):")
        print("  tiny   — fastest, ~75 MB, low quality")
        print("  base   — fast, ~150 MB")
        print("  small  — good balance, ~500 MB")
        print("  medium — (default) great for Russian, ~1.5 GB")
        print("  large  — best quality, ~3 GB, slow")
        print()
        print("Examples:")
        print("  python3 transcribe.py lecture.mp4")
        print("  python3 transcribe.py lecture.mp4 large ru")
        print("  python3 transcribe.py interview.mp4 small en")
        sys.exit(0)

    video_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "medium"
    language = sys.argv[3] if len(sys.argv) > 3 else "ru"

    if not os.path.exists(video_path):
        sys.exit(f"File not found: {video_path}")

    transcribe(video_path, model_name, language)
