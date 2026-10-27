import { createRequire } from 'node:module';
import { join } from 'node:path';

if (process.send) {
  process.once('message', async ({ bytes, runtime, maxSeconds }) => {
    try {
      let silk;
      try { silk = createRequire(join(runtime, 'package.json'))('silk-wasm'); }
      catch { throw new Error('AUDIO_SILK_RUNTIME_UNAVAILABLE'); }
      const duration = silk.getDuration(bytes);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('AUDIO_FORMAT_UNSUPPORTED');
      if (duration > maxSeconds * 1000) throw new Error('AUDIO_DURATION_LIMIT');
      const decoded = await silk.decode(bytes, 16000);
      if (decoded.data.length % 2) throw new Error('AUDIO_PCM_INVALID');
      if (decoded.data.length > maxSeconds * 16000 * 2) throw new Error('AUDIO_DURATION_LIMIT');
      const data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
      const samples = new Float32Array(data.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
      process.send({ samples });
    } catch (error) {
      process.send({ error: /^AUDIO_[A-Z_]+$/.test(error.message) ? error.message : 'AUDIO_FORMAT_UNSUPPORTED' });
    }
  });
  process.on('disconnect', () => process.exit(0));
}
