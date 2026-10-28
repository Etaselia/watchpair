import path from "node:path";

// Node can read long Windows paths, but the bundled native media tools need
// the extended-length form. Convert only standalone filesystem arguments;
// URLs, filters, option values, and relative output names keep their meaning.
export function mediaToolPath(value, platform = process.platform) {
  if (platform !== "win32" || typeof value !== "string" || !/^(?:[a-z]:[\\/]|\\\\)/i.test(value)) return value;
  return path.win32.toNamespacedPath(value);
}

export function mediaToolArguments(values, platform = process.platform) {
  return values.map((value) => mediaToolPath(value, platform));
}
