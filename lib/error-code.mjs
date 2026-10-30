// Return only bounded machine codes, never raw exception text, URLs or stacks.
export function errorCode(error, fallback = 'TOOL_FAILED') {
  const seen = new Set();
  for (let current = error; current && !seen.has(current) && seen.size < 8; current = current.cause) {
    seen.add(current);
    for (const value of [current.message, current.code]) {
      if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(value)) return value;
    }
  }
  return fallback;
}
