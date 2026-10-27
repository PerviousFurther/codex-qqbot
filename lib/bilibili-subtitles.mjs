const maxBytes = 2 * 1024 * 1024;

function parseSubtitleBody(document) {
  if (!Array.isArray(document.body)) throw new Error('Subtitle body is not a cue array');
  return document.body.map((cue, index) => {
    if (!Number.isFinite(cue.from) || !Number.isFinite(cue.to)
      || cue.from < 0 || cue.to < cue.from || typeof cue.content !== 'string') {
      throw new Error(`Invalid subtitle cue at index ${index}`);
    }
    return { start_seconds: cue.from, end_seconds: cue.to, text: cue.content };
  });
}

async function readSubtitleTrack(page, track) {
  const url = new URL(track.subtitle_url, page.url());
  if (url.protocol !== 'https:' || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) {
    throw new Error('Unexpected subtitle source');
  }
  // Stream a bounded text response. Do not retain signed URLs or account cookies.
  const response = await fetch(url, {
    headers: { Referer: page.url(), 'User-Agent': await page.evaluate(() => navigator.userAgent) },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Subtitle HTTP ${response.status}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Subtitle exceeds the 2 MiB limit');
    chunks.push(chunk);
  }
  return { bytes, cues: parseSubtitleBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))) };
}

// Attach before navigation so a fast player metadata response is not missed.
export function observeBilibiliSubtitles(page) {
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.hostname === 'api.bilibili.com' && /^\/x\/player\/(?:wbi\/)?v2$/.test(url.pathname);
  }, { timeout: 20_000 }).then(async response => {
    if (!response.ok()) return { status: 'METADATA_HTTP_ERROR', httpStatus: response.status() };
    const payload = await response.json();
    if (payload.code !== 0) return { status: 'METADATA_API_ERROR', apiCode: payload.code };
    const data = payload.data;
    if (!data || !Array.isArray(data.subtitle?.subtitles)) return { status: 'METADATA_FORMAT_UNKNOWN' };
    const tracks = data.subtitle.subtitles;
    const result = {
      status: data.need_login_subtitle ? 'LOGIN_REQUIRED' : 'NO_ACCESSIBLE_TRACKS',
      needLogin: Boolean(data.need_login_subtitle),
      tracks: tracks.map(track => ({
        language: track.lan, label: track.lan_doc,
        aiType: track.ai_type ?? null,
        hasDownloadUrl: typeof track.subtitle_url === 'string' && track.subtitle_url.length > 0,
      })),
      cues: [],
    };
    // Even if metadata exposes a URL, respect the player's explicit login gate.
    if (result.needLogin) return result;
    const downloadable = tracks.filter(track => typeof track.subtitle_url === 'string' && track.subtitle_url);
    const selected = downloadable.find(track => /^(?:ai-)?zh/.test(track.lan)) ?? downloadable[0];
    if (!selected) return result;
    try {
      const body = await readSubtitleTrack(page, selected);
      return {
        ...result, status: body.cues.length ? 'AVAILABLE' : 'EMPTY_TRACK',
        selectedLanguage: selected.lan, selectedLabel: selected.lan_doc,
        bytes: body.bytes, cues: body.cues,
      };
    } catch (error) {
      // Signed source URLs can appear in network errors; keep them out of reports.
      return { ...result, status: 'TRACK_READ_FAILED', error: error.message.replace(/https?:\/\/\S+/g, '[url]') };
    }
  }).catch(error => ({ status: error.name === 'TimeoutError' ? 'METADATA_TIMEOUT' : 'METADATA_READ_FAILED' }));
  return () => pending;
}
