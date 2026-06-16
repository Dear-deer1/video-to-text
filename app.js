// ── Preload transformers.js in background so it's ready when user clicks ──
let _lib = null;
const _libReady = import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
  .then(m => {
    m.env.allowLocalModels = false;
    m.env.backends.onnx.wasm.proxy = true; // run ONNX in a Web Worker → no UI freeze
    _lib = m;
  })
  .catch(() => {});

async function getLib() {
  await _libReady;
  if (!_lib) {
    _lib = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    _lib.env.allowLocalModels = false;
    _lib.env.backends.onnx.wasm.proxy = true;
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
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
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

  let chunksEstimated = 1;
  let chunksDone      = 0;
  let chunkStartTime  = null;
  let partial         = '';

  try {
    // 1. Extract audio in a Web Worker (non-blocking)
    setPulse('Читаю файл...');
    const { mono: audio, duration } = await extractAudioInWorker(file, msg => setPulse(msg));
    chunksEstimated = Math.max(1, Math.ceil(duration / 25));

    // 2. Load (or reuse) the Whisper model
    const modelName = $('modelSelect').value;
    if (!cachedPipeline || cachedModel !== modelName) {
      cachedModel    = modelName;
      cachedPipeline = null;

      const { pipeline } = await getLib();
      const dlStats = {};

      setPulse('Загружаю модель...');

      cachedPipeline = await pipeline('automatic-speech-recognition', modelName, {
        progress_callback: p => {
          if (p.status === 'downloading') {
            if (p.file !== dlStats.file) {
              dlStats.file  = p.file;
              dlStats.start = Date.now();
            }

            const elapsed = (Date.now() - dlStats.start) / 1000;
            const speed   = elapsed > 0.5 ? (p.loaded ?? 0) / elapsed : 0;
            const left    = speed > 0 ? ((p.total ?? 0) - (p.loaded ?? 0)) / speed : 0;

            const pct    = Math.round(p.progress ?? 0);
            const loaded = Math.round((p.loaded ?? 0) / 1e6);
            const total  = Math.round((p.total  ?? 0) / 1e6);

            const sizeStr = total > 0 ? ` (${loaded} / ${total} МБ)` : '';
            const etaStr  = speed > 100_000 && left > 3 && elapsed > 2
              ? `Скорость: ${fmtSize(Math.round(speed))}/с · ещё ${fmtTime(left)}`
              : '';

            showProgress(`Скачиваю модель: ${pct}%${sizeStr}`, pct, etaStr);

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
      msg.includes('memory')
        ? 'Файл слишком большой для браузера. Попробуй аудио-формат (mp3, m4a) или Python-скрипт из этой папки.'
        : msg.includes('decode')
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

// ── Audio extraction via Web Worker ──────────────────────────────────────
function extractAudioInWorker(file, onStatus) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('worker.js');

    worker.onmessage = ({ data }) => {
      if (data.type === 'status') {
        onStatus?.(data.msg);
      } else if (data.type === 'done') {
        worker.terminate();
        resolve({ mono: data.mono, duration: data.duration });
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.msg));
      }
    };

    worker.onerror = e => {
      worker.terminate();
      reject(new Error(e.message ?? 'Worker error'));
    };

    worker.postMessage({ file });
  });
}

// ── Progress helpers ──────────────────────────────────────────────────────
let _pulseTimer = null;

function clearPulseTimer() {
  if (_pulseTimer) { clearInterval(_pulseTimer); _pulseTimer = null; }
}

function showProgress(status, pct, eta) {
  clearPulseTimer();
  progressCard.classList.add('visible');
  barFill.classList.remove('pulse');
  barFill.style.width        = Math.min(pct, 100) + '%';
  progressStatus.textContent = status;
  progressPct.textContent    = pct > 0 && pct < 100 ? pct + '%' : '';
  progressEta.textContent    = eta ?? '';
}

function setPulse(status) {
  clearPulseTimer();
  progressCard.classList.add('visible');
  barFill.classList.add('pulse');
  progressStatus.textContent = status;
  progressPct.textContent    = '';

  const start = Date.now();
  progressEta.textContent = '0 сек';
  _pulseTimer = setInterval(() => {
    progressEta.textContent = Math.round((Date.now() - start) / 1000) + ' сек';
  }, 1000);
}

function showError(msg) {
  clearPulseTimer();
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
