// ── Preload transformers.js in background so it's ready when user clicks ──
let _lib = null;
const _libReady = import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
  .then(m => { m.env.allowLocalModels = false; _lib = m; })
  .catch(() => {});

async function getLib() {
  await _libReady;
  if (!_lib) {
    _lib = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    _lib.env.allowLocalModels = false;
  }
  return _lib;
}

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dropZone       = $('dropZone');
const fileInput      = $('fileInput');
const fileBadge      = $('fileBadge');
const fileNameEl     = $('fileNameEl');
const fileSizeEl     = $('fileSizeEl');
const sizeWarn       = $('sizeWarn');
const startBtn       = $('startBtn');
const errorCard      = $('errorCard');
const progressCard   = $('progressCard');
const progressStatus = $('progressStatus');
const progressPct    = $('progressPct');
const progressEta    = $('progressEta');
const barFill        = $('barFill');
const resultCard     = $('resultCard');
const resultText     = $('resultText');
const charCount      = $('charCount');
const copyBtn        = $('copyBtn');
const dlTxtBtn       = $('dlTxtBtn');
const dlDocxBtn      = $('dlDocxBtn');

// ── State ─────────────────────────────────────────────────────────────────
let selectedFile    = null;
let cachedPipeline  = null;
let cachedModel     = null;
let currentBaseName = '';

// ── File selection ────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => setFile(e.target.files[0]));

function fmtSize(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' ГБ';
  if (b >= 1e6) return Math.round(b / 1e6) + ' МБ';
  return Math.round(b / 1e3) + ' КБ';
}

function fmtTime(s) {
  if (s >= 3600) return `~${Math.round(s / 3600)} ч`;
  if (s >= 60)   return `~${Math.round(s / 60)} мин`;
  return `~${Math.round(s)} сек`;
}

function setFile(file) {
  if (!file) return;
  selectedFile    = file;
  currentBaseName = file.name.replace(/\.[^.]+$/, '');

  dropZone.classList.add('has-file');
  fileBadge.style.display = 'flex';
  fileNameEl.textContent  = '📄 ' + file.name;
  fileSizeEl.textContent  = fmtSize(file.size);
  sizeWarn.style.display  = file.size > 300e6 ? 'inline-flex' : 'none';

  startBtn.disabled    = false;
  startBtn.textContent = 'Транскрибировать';
  hideError();
}

// ── Main flow ─────────────────────────────────────────────────────────────
startBtn.addEventListener('click', () => { if (selectedFile) run(selectedFile); });

async function run(file) {
  startBtn.disabled    = true;
  startBtn.textContent = 'Работаю...';
  hideError();
  resultCard.classList.remove('visible');
  resultText.value      = '';
  charCount.textContent = '';
  showProgress('Декодирование аудио...', 0, '');

  let totalDuration   = 0;
  let chunksEstimated = 1;
  let chunksDone      = 0;
  let chunkStartTime  = null;
  let partial         = '';

  try {
    // 1. Extract audio from video/audio file
    const audio = await extractAudio(file, dur => {
      totalDuration   = dur;
      chunksEstimated = Math.max(1, Math.ceil(dur / 25));
      showProgress(`Аудио: ${Math.round(dur)} сек · Загружаю модель...`, 0, '');
    });

    // 2. Load (or reuse) the Whisper model
    const modelName = $('modelSelect').value;
    if (!cachedPipeline || cachedModel !== modelName) {
      cachedModel    = modelName;
      cachedPipeline = null;

      const { pipeline } = await getLib();
      const dlStats = {};

      cachedPipeline = await pipeline('automatic-speech-recognition', modelName, {
        progress_callback: p => {
          if (p.status === 'downloading') {
            // Reset timer when a new file starts downloading
            if (p.file !== dlStats.file) {
              dlStats.file  = p.file;
              dlStats.start = Date.now();
            }

            const elapsed = (Date.now() - dlStats.start) / 1000;
            const speed   = elapsed > 0.5 ? (p.loaded ?? 0) / elapsed : 0; // bytes/s
            const left    = speed > 0 ? ((p.total ?? 0) - (p.loaded ?? 0)) / speed : 0;

            const pct    = Math.round(p.progress ?? 0);
            const loaded = Math.round((p.loaded ?? 0) / 1e6);
            const total  = Math.round((p.total  ?? 0) / 1e6);

            const sizeStr = total > 0 ? `${loaded} / ${total} МБ` : '';
            const etaStr  = speed > 100_000 && left > 3 && elapsed > 2
              ? `Скорость: ${fmtSize(Math.round(speed))}/с · ещё ${fmtTime(left)}`
              : '';

            showProgress(`Скачиваю модель: ${pct}%${sizeStr ? ` (${sizeStr})` : ''}`, pct, etaStr);

          } else if (p.status === 'loading') {
            setPulse('Загружаю модель в память...');
          }
        },
      });
    }

    // 3. Transcribe — text appears chunk by chunk
    setPulse('Транскрибирую...');
    resultCard.classList.add('visible');
    const lang = $('langSelect').value || undefined;

    const result = await cachedPipeline(audio, {
      language: lang,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
      chunk_callback: chunk => {
        const now = Date.now();
        if (!chunkStartTime) chunkStartTime = now;
        chunksDone++;

        partial += chunk.text ?? '';
        resultText.value = partial;
        updateStats(partial);

        const elapsed     = (now - chunkStartTime) / 1000;
        const avgPerChunk = elapsed / chunksDone;
        const left        = (chunksEstimated - chunksDone) * avgPerChunk;
        const pct         = Math.min((chunksDone / chunksEstimated) * 100, 95);
        const etaStr      = chunksDone >= 2 && left > 5 ? `Ещё ${fmtTime(left)}` : '';

        showProgress(`Транскрибирую: ${Math.round(pct)}%`, pct, etaStr);
      },
    });

    // 4. Replace streaming preview with final clean text
    const finalText = result.text.trim();
    resultText.value = finalText;
    updateStats(finalText);
    showProgress('Готово!', 100, '');

  } catch (err) {
    const msg = err?.message ?? String(err);
    const friendly =
      msg.includes('memory') || msg.includes('RangeError')
        ? 'Файл слишком большой для браузера. Попробуй аудио-формат (mp3, m4a) или Python-скрипт из этой папки.'
        : msg.includes('decode') || msg.includes('codec')
        ? 'Браузер не смог декодировать этот формат. Попробуй mp4, mp3 или m4a.'
        : msg;

    showError(friendly);
    resultCard.classList.remove('visible');
    console.error(err);
  } finally {
    startBtn.disabled    = false;
    startBtn.textContent = 'Транскрибировать ещё раз';
  }
}

// ── Audio extraction ──────────────────────────────────────────────────────
async function extractAudio(file, onDuration) {
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch {
    throw new Error('memory: не удалось загрузить файл в память');
  }

  const ctx = new AudioContext({ sampleRate: 16000 });
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('decode: браузер не смог декодировать аудио-дорожку');
  }

  if (onDuration) onDuration(decoded.duration);

  // Mix channels down to mono in 500k-sample chunks to avoid freezing the UI
  const mono  = new Float32Array(decoded.length);
  const CHUNK = 500_000;

  for (let start = 0; start < decoded.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const d = decoded.getChannelData(ch);
      for (let i = start; i < end; i++) mono[i] += d[i] / decoded.numberOfChannels;
    }
    if (start + CHUNK < decoded.length) {
      await new Promise(r => setTimeout(r, 0)); // yield to UI thread
    }
  }

  return mono;
}

// ── Progress helpers ──────────────────────────────────────────────────────
function showProgress(status, pct, eta) {
  progressCard.classList.add('visible');
  barFill.classList.remove('pulse');
  barFill.style.width     = Math.min(pct, 100) + '%';
  progressStatus.textContent = status;
  progressPct.textContent    = pct > 0 && pct < 100 ? pct + '%' : '';
  progressEta.textContent    = eta ?? '';
}

function setPulse(status) {
  progressCard.classList.add('visible');
  barFill.classList.add('pulse');
  progressStatus.textContent = status;
  progressPct.textContent    = '';
  progressEta.textContent    = '';
}

function showError(msg) {
  errorCard.textContent = '⚠️ ' + msg;
  errorCard.classList.add('visible');
  progressCard.classList.remove('visible');
}

function hideError() { errorCard.classList.remove('visible'); }

function updateStats(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  charCount.textContent =
    `${text.length.toLocaleString('ru')} символов · ${words.toLocaleString('ru')} слов`;
}

// ── Buttons ───────────────────────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultText.value);
    copyBtn.textContent = 'Скопировано ✓';
    setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 2000);
  } catch {
    resultText.select();
    document.execCommand('copy');
  }
});

dlTxtBtn.addEventListener('click', () => {
  triggerDownload(
    new Blob([resultText.value], { type: 'text/plain;charset=utf-8' }),
    currentBaseName + '.txt',
  );
});

dlDocxBtn.addEventListener('click', async () => {
  dlDocxBtn.disabled    = true;
  dlDocxBtn.textContent = 'Генерирую...';
  try {
    const { Document, Packer, Paragraph, TextRun } = await import('https://esm.sh/docx@9.5.0');
    const text = resultText.value;
    const paragraphs = text
      .split(/\n+/)
      .filter(p => p.trim())
      .map(line => new Paragraph({ children: [new TextRun({ text: line, size: 24, font: 'Arial' })] }));

    if (!paragraphs.length) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text, size: 24, font: 'Arial' })] }));
    }

    const doc  = new Document({ sections: [{ properties: {}, children: paragraphs }] });
    const blob = await Packer.toBlob(doc);
    triggerDownload(blob, currentBaseName + '.docx');
  } catch (err) {
    showError('Не удалось создать .docx: ' + (err?.message ?? err));
  } finally {
    dlDocxBtn.disabled    = false;
    dlDocxBtn.textContent = 'Скачать .docx';
  }
});

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
