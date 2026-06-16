// Audio extraction worker — runs off the main thread so the page stays responsive

self.onmessage = async ({ data: { file } }) => {
  const send = (type, extra) => self.postMessage({ type, ...extra });

  try {
    send('status', { msg: 'Читаю файл...' });

    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch {
      throw new Error('memory');
    }

    send('status', { msg: 'Декодирую аудио...' });

    // AudioContext is available in Chrome workers (v88+); OfflineAudioContext is a wider fallback
    let decoded;
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      decoded = await ctx.decodeAudioData(buf);
    } catch {
      // Fallback: OfflineAudioContext — available in more browsers
      try {
        const ctx = new OfflineAudioContext(1, 1, 16000);
        decoded = await ctx.decodeAudioData(buf);
      } catch {
        throw new Error('decode');
      }
    }

    send('status', { msg: `Подготовка аудио (${Math.round(decoded.duration)} сек)...` });

    // Mix down to mono
    const { length, numberOfChannels, duration } = decoded;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const d = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += d[i] / numberOfChannels;
    }

    // Transfer buffer (zero-copy — no duplication in memory)
    self.postMessage({ type: 'done', mono, duration }, [mono.buffer]);

  } catch (err) {
    send('error', { msg: err.message ?? String(err) });
  }
};
