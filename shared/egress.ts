import { lookup } from "node:dns/promises";

export interface Egress {
  allowPrivate?: boolean;
  hosts?: (u: URL) => boolean;
}

const bad = (message: string): never => {
  throw { code: "bad_url", message };
};

function octets(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function priv4(p: number[]): boolean {
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function hex4(t: string): number[] | null {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(t);
  if (!m) return null;
  const a = parseInt(m[1], 16);
  const b = parseInt(m[2], 16);
  return [a >> 8, a & 255, b >> 8, b & 255];
}

function priv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("::ffff:")) {
    const v4 = octets(s.slice(7)) ?? hex4(s.slice(7));
    return v4 ? priv4(v4) : true;
  }
  if (s.startsWith("ff") || s.startsWith("fc") || s.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(s)) return true;
  if (s.startsWith("2002:") || s.startsWith("64:ff9b:")) return true;
  return false;
}

async function privTarget(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  const v4 = octets(h);
  if (v4) return priv4(v4);
  if (h.includes(":")) return priv6(h);
  try {
    const addrs = await lookup(h, { all: true });
    return addrs.some((a) =>
      a.family === 4 ? priv4(octets(a.address) ?? [0, 0, 0, 0]) : priv6(a.address),
    );
  } catch {
    return false;
  }
}

async function chkUrl(raw: string, eg: Egress): Promise<string> {
  const u = URL.parse(raw);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) bad("url scheme not allowed");
  if (u!.username || u!.password) bad("credentialed url not allowed");
  if (eg.hosts && !eg.hosts(u!)) bad("host not allowed");
  if (!eg.allowPrivate && (await privTarget(u!.hostname))) bad("target address not allowed");
  return u!.toString();
}

const REDIR = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  eg: Egress = {},
): Promise<Response> {
  let cur = url;
  for (let i = 0; ; i++) {
    cur = await chkUrl(cur, eg);
    const r = await fetch(cur, { ...init, redirect: "manual" });
    if (!REDIR.has(r.status)) return r;
    const loc = r.headers.get("location");
    r.body?.cancel().catch(() => {});
    if (!loc || i >= 5) throw { code: "upstream", message: "too many redirects" };
    cur = new URL(loc, cur).toString();
  }
}

export async function readBody(r: Response, cap: number): Promise<Buffer | null> {
  if (Number(r.headers.get("content-length")) > cap) {
    r.body?.cancel().catch(() => {});
    return null;
  }
  if (!r.body) return Buffer.alloc(0);
  const rd = r.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      rd.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
