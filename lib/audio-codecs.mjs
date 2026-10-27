import { contentCodecs } from './content-codecs.mjs';

// One speech unit becomes one transcript unit; segmentation is a stream transform.
contentCodecs.register('audio.speech', 'audio.transcript', async (speech, context) => {
  const text = await context.decoder.transcribe(speech.samples, context.signal);
  return { start_seconds: speech.start_seconds, end_seconds: speech.end_seconds,
    text, untrusted: true, timing: 'vad_segment', engine: 'qwen3-asr-0.6b-int8' };
});
contentCodecs.register('audio.transcript', 'text', value => value.text);
