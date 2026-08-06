#!/usr/bin/env python3
import sys
import os
import tempfile
import subprocess


# ── ffmpeg ────────────────────────────────────────────────────────────────

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
        sys.exit("ffmpeg не найден. Запусти: pip3 install imageio-ffmpeg")


def extract_audio(source_path, ffmpeg_bin):
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    result = subprocess.run(
        [ffmpeg_bin, "-y", "-i", source_path,
         "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmp.name],
        capture_output=True,
    )
    if result.returncode != 0:
        os.unlink(tmp.name)
        sys.exit(f"Ошибка ffmpeg:\n{result.stderr.decode()}")
    return tmp.name


# ── URL / yt-dlp ──────────────────────────────────────────────────────────

def is_url(s):
    return s.startswith(("http://", "https://"))


def download_audio_from_url(url):
    """Download audio from YouTube, MTS Link, RuTube, VK and 1000+ other sites via yt-dlp."""
    try:
        import yt_dlp
    except ImportError:
        sys.exit(
            "yt-dlp не установлен. Запусти: pip3 install yt-dlp\n"
            "Затем повтори команду."
        )

    outdir = tempfile.mkdtemp()
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(outdir, "%(title)s.%(ext)s"),
        "quiet": False,
        "no_warnings": False,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }],
    }

    print(f"Скачиваю аудио с: {url}")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get("title", "audio")

    for fname in os.listdir(outdir):
        if fname.endswith(".wav"):
            return os.path.join(outdir, fname), title

    sys.exit("Не удалось скачать аудио по ссылке.")


# ── Whisper ───────────────────────────────────────────────────────────────

def transcribe_audio(audio_path, model_name, language, output_path):
    try:
        import whisper
    except ImportError:
        sys.exit("whisper не установлен. Запусти: pip3 install openai-whisper")

    print(f"Загружаю модель Whisper '{model_name}'...")
    model = whisper.load_model(model_name)

    print("Транскрибирую...")
    result = model.transcribe(audio_path, language=language)
    text = result["text"].strip()

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text)

    print(f"\nГотово! Сохранено в: {output_path}\n")
    print("─── Превью (первые 500 символов) ───")
    print(text[:500])


# ── Entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Использование:")
        print("  python3 transcribe.py <файл_или_ссылка> [модель] [язык]")
        print()
        print("Примеры:")
        print("  python3 transcribe.py lecture.mp4")
        print("  python3 transcribe.py https://youtube.com/watch?v=... medium ru")
        print("  python3 transcribe.py https://mts-link.ru/record/...")
        print("  python3 transcribe.py interview.mp4 large ru")
        print()
        print("Модели:  tiny · base · small · medium (по умолчанию) · large")
        print("Языки:   ru (по умолчанию) · en · de · fr · ...")
        sys.exit(0)

    source     = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "medium"
    language   = sys.argv[3] if len(sys.argv) > 3 else "ru"

    ffmpeg_bin  = get_ffmpeg()
    tmp_audio   = None
    output_path = None

    try:
        if is_url(source):
            audio_path, title = download_audio_from_url(source)
            tmp_audio   = audio_path
            output_path = os.path.join(os.getcwd(), title + ".txt")
        else:
            if not os.path.exists(source):
                sys.exit(f"Файл не найден: {source}")
            print(f"Извлекаю аудио из: {os.path.basename(source)}")
            audio_path  = extract_audio(source, ffmpeg_bin)
            tmp_audio   = audio_path
            output_path = os.path.splitext(source)[0] + ".txt"

        transcribe_audio(audio_path, model_name, language, output_path)

    finally:
        if tmp_audio and os.path.exists(tmp_audio):
            os.unlink(tmp_audio)
