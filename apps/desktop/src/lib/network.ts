const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^::1$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

/** True if `url` is plain http to a host outside localhost/private-LAN ranges. */
export function isInsecureRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return !PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
}
