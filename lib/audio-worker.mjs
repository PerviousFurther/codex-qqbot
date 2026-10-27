import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

// This module is only an isolated native process entry, never an application import.
const rate = 16000;
const window = 512;
let sherpa, vad, recognizer, config;
let history = new Float32Array(), historyStart = 0, received = 0, tail = new Float32Array();
let active = false;

async function initialize(settings) {
  if (sherpa) return;
  config = settings;
  try {
    const require = createRequire(join(config.runtime, 'package.json'));
    sherpa = require('sherpa-onnx-node');
  } catch { throw new Error('AUDIO_RUNTIME_UNAVAILABLE'); }
  try { await access(config.vadModel); }
  catch { throw new Error('AUDIO_MODEL_UNAVAILABLE'); }
  vad = new sherpa.Vad({ sileroVad: { model: config.vadModel, threshold: 0.5,
    minSpeechDuration: 0.25, minSilenceDuration: config.silenceSeconds,
    maxSpeechDuration: config.maxSpeechSeconds, windowSize: window },
  sampleRate: rate, numThreads: 1, provider: 'cpu', debug: false }, config.maxSpeechSeconds + 10);
}

function drain() {
  const segments = [];
  while (!vad.isEmpty()) {
    // Copy before pop: native segment views may become invalid afterwards.
    const segment = vad.front(false);
    const padding = Math.round(config.paddingSeconds * rate);
    const start = Math.max(0, segment.start - padding);
    const end = Math.min(received, segment.start + segment.samples.length + padding);
    if (start < historyStart || end > historyStart + history.length || end <= start) throw new Error('AUDIO_VAD_RANGE_INVALID');
    segments.push({ samples: history.slice(start - historyStart, end - historyStart),
      start_seconds: start / rate, end_seconds: end / rate });
    vad.pop();
  }
  return segments;
}

function push(samples) {
  const next = new Float32Array(history.length + samples.length);
  next.set(history); next.set(samples, history.length);
  history = next;
  received += samples.length;
  const frames = new Float32Array(tail.length + samples.length);
  frames.set(tail); frames.set(samples, tail.length);
  const segments = [];
  let i = 0;
  for (; i + window <= frames.length; i += window) {
    vad.acceptWaveform(frames.subarray(i, i + window));
    segments.push(...drain());
  }
  tail = frames.slice(i);
  // Keep enough context for the longest pending speech, silence and padding.
  const keep = Math.ceil((config.maxSpeechSeconds + config.silenceSeconds + 5) * rate);
  if (history.length > keep) {
    historyStart += history.length - keep;
    history = history.slice(-keep);
  }
  return segments;
}

async function run(op, data, settings) {
  await initialize(settings);
  if (op === 'start') {
    vad.reset(); vad.clear();
    history = new Float32Array(); historyStart = 0; received = 0; tail = new Float32Array();
    active = true;
    return null;
  }
  if (op === 'transcribe') {
    if (!recognizer) {
      for (const file of ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx', 'tokenizer']) {
        try { await access(join(config.modelDir, file)); }
        catch { throw new Error('AUDIO_MODEL_UNAVAILABLE'); }
      }
      recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: rate, featureDim: 80 },
        modelConfig: { qwen3Asr: { convFrontend: join(config.modelDir, 'conv_frontend.onnx'),
          encoder: join(config.modelDir, 'encoder.int8.onnx'), decoder: join(config.modelDir, 'decoder.int8.onnx'),
          tokenizer: join(config.modelDir, 'tokenizer'), hotwords: '' },
        tokens: '', numThreads: config.numThreads, provider: 'cpu', debug: false } });
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: rate, samples: data });
    recognizer.decode(stream);
    return recognizer.getResult(stream).text?.trim() ?? '';
  }
  if (!active) throw new Error('AUDIO_STREAM_NOT_STARTED');
  if (op === 'push') return push(data);
  if (op === 'flush') {
    if (tail.length) {
      const last = new Float32Array(window);
      last.set(tail);
      vad.acceptWaveform(last);
      tail = new Float32Array();
    }
    vad.flush();
    active = false;
    const segments = drain();
    history = new Float32Array();
    return segments;
  }
  throw new Error('AUDIO_OPERATION_INVALID');
}

if (process.send) {
  process.on('message', async ({ id, op, data, config: settings }) => {
    try { process.send({ id, value: await run(op, data, settings) }); }
    catch (error) {
      process.send({ id, error: /^AUDIO_[A-Z_]+$/.test(error.message) ? error.message : 'AUDIO_DECODE_FAILED' });
    }
  });
  process.on('disconnect', () => process.exit(0));
}
