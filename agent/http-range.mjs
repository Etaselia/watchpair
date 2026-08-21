/** Parse one RFC 9110 byte range. Multiple ranges are intentionally unsupported. */
export function parseByteRange(value, size) {
  const length = Number(size);
  if (!Number.isSafeInteger(length) || length < 0) return false;
  if (value === undefined || value === null || value === "") return null;
  const input = String(value).trim();
  if (input.includes(",")) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(input);
  if (!match || (!match[1] && !match[2]) || length === 0) return false;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    return { start: Math.max(0, length - suffixLength), end: length - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : length - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= length ||
    requestedEnd < start
  ) return false;
  return { start, end: Math.min(requestedEnd, length - 1) };
}
