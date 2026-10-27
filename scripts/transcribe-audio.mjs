import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { AudioDecoder } from '../lib/audio-decoder.mjs';
import { fileAudioStream } from '../lib/audio-source.mjs';

// Explicit operator entry, not a startup hook or bot/MCP tool.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  model: { type: 'string' }, vad: { type: 'string' }, runtime: { type: 'string' },
  start: { type: 'string', default: '0' }, duration: { type: 'string', default: '120' },
  threads: { type: 'string', default: '2' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node scripts/transcribe-audio.mjs --model QWEN_DIR --vad SILERO.onnx [--runtime DIR] [--start 0] [--duration 120] [--threads 2] LOCAL_MEDIA_FILE');
} else {
  let decoder;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (positionals.length !== 1) throw new Error('AUDIO_FILE_REQUIRED');
    const start = Number(values.start), duration = Number(values.duration);
    decoder = new AudioDecoder({ modelDir: values.model, vadModel: values.vad,
      runtime: values.runtime, numThreads: Number(values.threads) });
    const pcm = fileAudioStream(positionals[0], { startSeconds: start, durationSeconds: duration, signal: controller.signal });
    const started = performance.now();
    let segments = 0;
    for await (const transcript of decoder.decode(pcm, { offsetSeconds: start, maxSeconds: duration, signal: controller.signal })) {
      if (!process.stdout.write(`${JSON.stringify(transcript)}\n`)) await once(process.stdout, 'drain', { signal: controller.signal });
      segments++;
    }
    console.error(JSON.stringify({ status: 'complete', segments, elapsed_seconds: (performance.now() - started) / 1000 }));
  } catch (error) {
    console.error(controller.signal.aborted ? 'AUDIO_ABORTED'
      : /^AUDIO_[A-Z_]+$/.test(error.message) ? error.message : 'AUDIO_TRANSCRIPTION_FAILED');
    process.exitCode = 1;
  } finally {
    decoder?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
