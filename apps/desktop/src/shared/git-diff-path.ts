/** Git quotes paths with C escapes; octal sequences are UTF-8 bytes. */
export function decodeGitDiffPath(value: string): string | null {
  value = value.replace(/\r$/u, "");
  if (!value.startsWith('"')) return value.split("\t")[0]!;
  const match = /^"((?:[^"\\]|\\(?:[0-7]{3}|[abfnrtv\\"]))*)"(?:\t.*)?$/u.exec(value);
  if (!match) return null;
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' };
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const part of match[1]!.matchAll(/\\([0-7]{3}|[abfnrtv\\"])|([^\\]+)/gu)) {
    if (part[2] !== undefined) { for (const byte of encoder.encode(part[2])) bytes.push(byte); }
    else if (/^[0-7]{3}$/u.test(part[1]!)) {
      const byte = parseInt(part[1]!, 8);
      if (byte > 255) return null;
      bytes.push(byte);
    } else bytes.push(...encoder.encode(escapes[part[1]!]!));
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); }
  catch { return null; }
}
