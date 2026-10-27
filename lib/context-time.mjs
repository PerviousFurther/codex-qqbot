// Compact Beijing-time (UTC+08:00) model timestamps; storage/query instants stay unchanged.
export function contextTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(2, 16).replaceAll('-', '/').replace('T', '-');
}
