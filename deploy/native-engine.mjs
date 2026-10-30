// Lazy imports keep app-only development and unit tests independent of native binaries.
export async function createNativeEngine(modelPath, threads = 2) {
  let hf, KokoroTTS;
  try {
    hf = await import('@huggingface/transformers');
    ({ KokoroTTS } = await import('kokoro-js'));
  } catch (error) { throw new Error(`Native speech dependencies could not load (${error.code || 'runtime error'}). Run npm ci; see WINDOWS.md or VPS.md for OS prerequisites.`); }
  hf.env.allowRemoteModels = false; hf.env.allowLocalModels = true;
  hf.env.useFSCache = false; hf.env.useBrowserCache = false;
  const model = await hf.StyleTextToSpeech2Model.from_pretrained(modelPath, {
    dtype: 'q8', device: 'cpu', local_files_only: true,
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1, logSeverityLevel: 3 },
  });
  const tokenizer = await hf.AutoTokenizer.from_pretrained(modelPath, { local_files_only: true });
  // kokoro-js normally silently truncates long phoneme sequences. Reject that and
  // split the original text instead, so exported narration never silently drops its tail.
  const safeTokenizer = (text, options) => {
    const encoded = tokenizer(text, { ...options, truncation: false });
    if (encoded.input_ids.dims.at(-1) > 512) { const error = new Error('Speech segment is too long.'); error.code = 'SPEECH_SEGMENT_LONG'; throw error; }
    return encoded;
  };
  const tts = new KokoroTTS(model, safeTokenizer);
  return { voices: Object.keys(tts.voices), generate: (text, voice) => generateComplete(tts, text, voice), dispose: () => model.dispose() };
}

export async function generateComplete(tts, text, voice) {
  const segments = [], limit = (8 * 1024 * 1024 - 44) / 2, silence = 2400;
  let samples = 0;
  async function synthesize(part) {
    let audio;
    try { audio = await tts.generate(part, { voice, speed: 1 }); }
    catch (error) {
      if (error.code !== 'SPEECH_SEGMENT_LONG') throw error;
      const spaces = [...part.matchAll(/\s+/g)].map(match => match.index).filter(index => index > 0 && index < part.length - 1);
      if (!spaces.length) throw new Error('Speech contains an excessively long unbroken word.');
      const middle = spaces.reduce((a, b) => Math.abs(a - part.length / 2) < Math.abs(b - part.length / 2) ? a : b);
      await synthesize(part.slice(0, middle).trim()); await synthesize(part.slice(middle).trim()); return;
    }
    if (!(audio.audio instanceof Float32Array) || audio.sampling_rate !== 24000) throw new Error('Invalid native audio.');
    samples += audio.audio.length + (segments.length ? silence : 0);
    if (samples > limit) throw new Error('Speech exceeds the audio size limit.');
    segments.push(audio.audio);
  }
  await synthesize(text);
  const joined = new Float32Array(samples); let offset = 0;
  for (const [index, segment] of segments.entries()) { if (index) offset += silence; joined.set(segment, offset); offset += segment.length; }
  return { audio: joined, sampling_rate: 24000 };
}
