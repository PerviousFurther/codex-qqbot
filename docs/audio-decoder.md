# Local audio-to-text decoder

The optional CPU decoder uses Silero VAD and Qwen3-ASR-0.6B INT8 through `sherpa-onnx-node`. It understands speech only; music classification, source separation, speaker diarization, word alignment and music descriptions are outside this implementation. VAD is not a music detector: singing or speech over music may still be selected/transcribed. Platform-provided QQ ASR remains available without local inference.

## Flow contract

```
authorized PCM iterator -> audio.pcm -> VAD stream transform
  -> audio.speech -> item decoder -> audio.transcript -> optional text encoder
```

`AudioDecoder.decode` accepts the existing `ContentStream` type. Each `audio.pcm` unit contains `{ sampleRate: 16000, samples: Float32Array }`, mono normalized to [-1, 1]. Blocks are contiguous, at most ten seconds each, without timestamp gaps. It accepts sync and async sources. Network download, decoding compressed media, source authorization and scheduling are outside the decoder. Callers recheck authorization/cancellation before supplying audio and returning transcripts.

VAD uses a 0.5 confidence threshold, a 250-ms minimum speech duration and a 500-ms silence boundary. Shorter pauses stay within a speech segment. Continuous speech is split at 20 seconds by default. Up to 150 ms of actual surrounding samples is included at each boundary; overlapping padding is intentional, not deduplicated text. A bounded rolling buffer retains the longest pending segment plus silence/padding; the recording is never collected wholesale. Final partial VAD frames are zero-padded internally, and returned times/samples are clipped to real input.

Outputs contain `text`, `start_seconds`, `end_seconds`, `untrusted: true`, `timing: "vad_segment"` and the engine name. Times cover the VAD segment with padding, not word alignment or guaranteed exact utterance timing. `offsetSeconds` maps a selected window back onto the original recording. Silence produces no units; an empty ASR result remains an empty transcript unit. No transcript is persisted automatically.

```js
import { contentCodecs } from '../lib/content-codecs.mjs';
import { AudioDecoder } from '../lib/audio-decoder.mjs';

const decoder = new AudioDecoder({ modelDir: '/data/models/qwen', vadModel: '/data/models/silero_vad.onnx' });
try {
  const pcm = contentCodecs.stream('audio.pcm', authorizedPcmIterator);
  const transcripts = decoder.decode(pcm, { signal, offsetSeconds: 0, maxSeconds: 120 });
  for await (const segment of transcripts) await destination.write(segment);
} finally {
  await decoder.close();
}
```

Use one application-owned decoder for sequential jobs. Overlapping flows fail with `AUDIO_DECODER_BUSY`; task queues belong to the caller. The native child process loads VAD on first iteration and ASR only on the first speech segment, and reuses the recognizer across successful flows. It receives PCM/configuration, not QQ credentials or chat metadata. Early exit/failure, abort, explicit close or a per-request timeout (five minutes by default) kills the child and discards pending state. A later flow creates a new child. Native failures return bounded error codes without raw stderr/file paths. Close the instance after use to release model memory. Process isolation does not impose an independent memory limit.

`fileAudioStream` is a separate source adapter: an already authorized local audio/video file goes through ffmpeg to bounded 16-kHz mono PCM blocks. Only file/pipe protocols are enabled; it does not download URLs or acquire authenticated player media. Its selected time window is bounded (up to one hour), and ffmpeg is killed on cancellation/early exit. Pass the same start offset and duration to source and decoder.

## Optional runtime setup

The main bot dependency tree/startup does not require native ASR. Install the isolated runtime explicitly when preparing an audio-capable environment:

```bash
npm install --prefix audio-runtime --omit=dev --no-audit --no-fund
```

The manifest pins `sherpa-onnx-node` to 2.0.0 and `silk-wasm` to 3.7.1. Keep the generated lockfile for repeatable local installations. The runtime must be installed for the target OS/architecture; copying host native modules into a different container is unsupported. `ffmpeg` must also be installed in the environment using the local-file adapter. The Docker build includes ffmpeg; the opt-in `WATCH_AUDIO_RUNTIME=true` build argument adds the native ASR/SILK packages. Deployment commands belong in [HANDOFF](../HANDOFF.md). A caller may specify another installation directory with `runtime` / `--runtime` (the directory containing its `package.json` and `node_modules`).

For this deployment, the host download helper and the read-only model mount are documented in [HANDOFF](../HANDOFF.md). `scripts/download-audio-models.sh HOST_MODEL_DIRECTORY` prepares the two models without entering a container.

Download models separately from the upstream [sherpa model release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models):

- `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`; extract it and use the directory containing `conv_frontend.onnx`, `encoder.int8.onnx`, `decoder.int8.onnx` and `tokenizer/`.
- [silero_vad.onnx](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx).

Model files are not installed, fetched at startup, or committed. Keep them outside the source tree and conversation workspaces. The existing host has about 3.8 GiB RAM and the bot container has a 2-GiB limit; this implementation has not established whether Qwen fits that limit or how fast it runs. VAD segmentation limits audio buffers, not model weights. Measure before integrating it into a running bot.

## Operator entry for later validation

This command performs real local inference only when explicitly invoked. It reads one local file, emits one JSON transcript per line to stdout and final timing/count metadata to stderr. It never connects QQ, calls an LLM endpoint or writes chat state.

```bash
node scripts/transcribe-audio.mjs --model /path/to/qwen-model --vad /path/to/silero_vad.onnx --start 0 --duration 30 /path/to/local-video.mp4
```

Start with a short speech fixture; then check silence, a final partial frame, long speech, pause boundaries, nonzero offsets and cancellation. Compare elapsed time and peak resident memory (for example with `/usr/bin/time -v`). Runtime installation, native compatibility, inference quality, resource usage and these functional tests remain for operator validation. The bot exposes an on-demand QQ audio tool as described below. Public direct audio/video can first be saved through checked acquisition. Saved audio uses get_audio_detail(file_name,method=local); saved video uses read_media(file_name,track=audio,start,end). Browser streaming playback is not a captured ASR source.

The native API follows upstream [Qwen example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_qwen3_asr.js) and [VAD example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_vad_with_non_streaming_asr_moonshine.js).

## QQ message tools

- `get_message_detail(id, offset, limit)` reads one page of direct nested messages/quotes. It does not decode attachments or recursively expand records.
- `get_image_detail(image_ids)` reads up to three received images with the existing scoped image reader.
- `get_audio_detail(id, method)` reads one audio attachment; `id` is its opaque attachment ID, not a message ID. The method is required and is either `qq` or `local`.

`qq` returns only QQ ASR already captured with the attachment (`source: qq_platform_asr`, `status: AVAILABLE` or `NOT_PROVIDED`). It does not invoke a QQ transcription API, download audio, or require local models. Existing inline QQ transcripts remain available. Missing text is not silently replaced by local inference.

`local` downloads only the retained URL for this conversation through the existing QQ-CDN allowlist (no redirects or arbitrary URL/path input). Downloads are limited to 8 MiB and audio to 120 seconds. SILK voice uses the optional [silk-wasm decoder](https://github.com/idranme/silk-wasm); WAV/MP3/Ogg/FLAC/AMR/MP4-family audio uses ffmpeg, subject to decoder support. SILK decoding buffers the bounded short clip in its isolated process before yielding PCM blocks; VAD/ASR still consume those blocks incrementally. Unsupported formats fail explicitly. Oversized/long audio is rejected rather than presented as a complete transcript of a prefix. Results include segment timestamps and `source: local_asr`, `status: TRANSCRIBED` or `NO_SPEECH_DETECTED`. Singing may still be transcribed; music understanding is not implemented.

Set these operator-controlled environment variables in the bot environment; the adapter forwards only these named audio settings to scoped MCP processes:

```text
WATCH_AUDIO_MODEL_DIR=/data/models/qwen
WATCH_AUDIO_VAD_MODEL=/data/models/silero_vad.onnx
WATCH_AUDIO_RUNTIME_DIR=/app/audio-runtime
WATCH_AUDIO_THREADS=2
```

Empty model paths produce `AUDIO_LOCAL_NOT_CONFIGURED`; `qq` mode still works. Paths are not model tool arguments. The opt-in Docker build described in HANDOFF provides the runtime and ffmpeg; install models separately in a location readable by the non-root runtime. No live environment values are changed by the source update.

Local calls share a single SQLite-backed job slot across conversation MCP processes. An occupied slot returns `AUDIO_DECODER_BUSY`; it does not queue or load another model. The owner token/PID contains no chat data, and a dead owner's slot can be reclaimed. Local calls have a 100-second total deadline within the existing 120-second MCP timeout, cap transcript output at 100 segments/12,000 characters and release model memory after every call. Audio files exist only in a private temporary directory, removed on normal completion, failure or cancellation; transcripts are returned to the current conversation and not automatically persisted. Access/retention is rechecked before/after download, between PCM/ASR stages and before returning results. Request cancellation reaches the decoder and extraction children. Server shutdown aborts and awaits active audio jobs before closing record databases.

Only syntax/module-import and static configuration checks have been performed for this integration. Actual QQ format delivery, CDN availability, runtime installation, native/SILK/ffmpeg decoding and recognition remain for operator tests.

## QQ video speech side branch

Use `read_media({turn_id, media_id, track: "audio", start, end})` for an explicit ≤120-second range of a received QQ video. It shares the existing media file, authorization, time axis, turn lifetime and aggregate cache. Audio has a separate queue; the same cross-process ASR slot also protects local voice-attachment decoding. It returns pending/ready/error with growing timestamped `segments`; normal frame reads never start recognition. `close_media` and turn closure abort/await extraction and native model exit before releasing the slot/file/cache. Missing audio/configuration and busy/error cases are explicit, without fallback or implicit retry.

The selected range includes up to 0.25 seconds of boundary context per side; VAD times map back to the video start and context overlap is marked. A query caps output at 100 segments/12,000 characters with a 100-second deadline. Exact duplicates within a query are removed; neighboring ranges may repeat context, not necessarily repeated speech. No-speech completion has an explicit status. This is local speech transcription, not sound-effect/music/emotion/speaker understanding. Public direct media uses the existing checked save_file path before decoding. Browser stream capture, DRM and arbitrary segmented-stream extraction are not supported. Live website/media compatibility and native resource use require operator validation.
