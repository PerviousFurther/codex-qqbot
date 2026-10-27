// Local media references name scoped resources, never arbitrary host files.
function localMedia(destination) {
  if (/^(?:https?:)?\/\//i.test(destination)) return null;
  const asset = /^(?:asset:\/\/|asset:|\/assets\/)([a-f0-9]{32})$/.exec(destination);
  if (asset) return { type: 'image', asset_id: asset[1] };
  const attachment = /^(?:attachment:\/\/|attachment:|\/attachments\/)(?:(image|audio)\/)?([a-f0-9]{32})$/.exec(destination);
  if (attachment) return { type: attachment[1] ?? 'image', attachment_id: attachment[2] };
  throw new Error('REPLY_LOCAL_MEDIA_UNAVAILABLE');
}

// Read inline image syntax without treating code examples or escaped punctuation as sends.
// Remote references remain byte-for-byte Markdown; only local references create boundaries.
export function replyParts(text, media) {
  const parts = []; let start = 0; let i = 0; let fence = null;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      const marker = /^( {0,3})(`{3,}|~{3,})/.exec(text.slice(i));
      if (marker && (!fence || marker[2][0] === fence[0] && marker[2].length >= fence.length
        && /^[ \t]*(?:\n|$)/.test(text.slice(i + marker[0].length)))) {
        fence = fence ? null : marker[2];
        const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue;
      }
    }
    if (fence) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))[0]; let end = i + run.length;
      while ((end = text.indexOf(run, end)) >= 0) {
        if (text[end - 1] !== '`' && text[end + run.length] !== '`') break;
        end += run.length;
      }
      i = end < 0 ? i + run.length : end + run.length; continue;
    }
    if (!text.startsWith('![', i)) { i++; continue; }
    let labelEnd = i + 2; let depth = 1;
    for (; labelEnd < text.length; labelEnd++) {
      if (text[labelEnd] === '\\') { labelEnd++; continue; }
      if (text[labelEnd] === '[') depth++;
      if (text[labelEnd] === ']' && --depth === 0) break;
    }
    if (text[labelEnd + 1] !== '(') { i++; continue; }
    let end = labelEnd + 2; depth = 1; let angle = false; let quote = null;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (quote) { if (text[end] === quote) quote = null; continue; }
      if (!angle && depth === 1 && /\s/.test(text[end - 1]) && ['\"', "'"].includes(text[end])) {
        quote = text[end]; continue;
      }
      if (text[end] === '<') angle = true;
      if (text[end] === '>') angle = false;
      if (!angle && text[end] === '(') depth++;
      if (!angle && text[end] === ')' && --depth === 0) break;
    }
    if (end === text.length) { i++; continue; }
    const body = text.slice(labelEnd + 2, end).trim();
    const destination = body.startsWith('<') ? body.slice(1, body.indexOf('>')) : body.split(/\s/)[0];
    const local = localMedia(destination);
    if (local) {
      if (text.slice(start, i).trim()) parts.push({ text: text.slice(start, i) });
      parts.push({ text: '', media: local }); start = end + 1;
    }
    i = end + 1;
  }
  if (text.slice(start).trim()) parts.push({ text: text.slice(start) });
  if (media) parts.push({ text: '', media });
  return parts;
}
