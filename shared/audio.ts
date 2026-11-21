import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Engine } from "./engine.ts";
import type { Config } from "./config.ts";
import { dl } from "./spotify.ts";
import { Device } from "widevine";

let dev: Promise<Device | null> | null = null;

function device(cfg: Config): Promise<Device | null> {
  if (!dev) {
    dev = Device.from({
      wvdPath: cfg.cdm.wvd_path,
      clientIdPath: cfg.cdm.device_client_id_path,
      privateKeyPath: cfg.cdm.device_private_key_path,
    });
  }
  return dev;
}

const TTL = 6 * 3600_000;
const key = randomBytes(32);

export function mint(source: string, id: string): string {
  const body = Buffer.from(JSON.stringify([source, id, Date.now() + TTL])).toString(
    "base64url",
  );
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function unmint(t: string) {
  const dot = t.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = t.slice(0, dot);
  const sig = Buffer.from(t.slice(dot + 1));
  const want = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string") {
      return undefined;
    }
    if (typeof v[2] !== "number" || v[2] < Date.now()) return undefined;
    return { source: v[0], id: v[1] };
  } catch {
    return undefined;
  }
}

const MAX_OUT = 64 * 1024 * 1024;
const RUN_MS = 120_000;
const MAX_PROCS = 8;
let procs = 0;

export function run(
  bin: string,
  args: string[],
  input?: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject({ code: "busy", message: "request aborted" });
      return;
    }
    if (procs >= MAX_PROCS) {
      reject({ code: "busy", message: "too many converter processes" });
      return;
    }
    procs++;
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const onAbort = () => p.kill();
    signal?.addEventListener("abort", onAbort);
    const out: Buffer[] = [];
    let size = 0;
    let timed = false;
    const t = setTimeout(() => {
      timed = true;
      p.kill();
    }, RUN_MS);
    p.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUT) p.kill();
      else out.push(c);
    });
    p.stderr.resume();
    p.on("error", () => reject({ code: "internal", message: `${bin} failed to start` }));
    p.on("close", (code) => {
      procs--;
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted && !timed) reject({ code: "busy", message: "request aborted" });
      else if (timed) reject({ code: "upstream", message: `${bin} timed out` });
      else if (size > MAX_OUT) reject({ code: "upstream", message: `${bin} output too large` });
      else if (code === 0) resolve(Buffer.concat(out));
      else reject({ code: "upstream", message: `${bin} exited ${code}` });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

export function ytUrl(
  id: string,
  format: string,
  bin: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^[\w-]{6,}$/.test(id)) throw { code: "invalid_id", message: "invalid video id" };
  const flags = format === "video" ? ["-f", "best[ext=mp4]/best"] : ["-f", "bestaudio/best"];
  return run(bin, ["-g", ...flags, "--", id], undefined, signal).then((out) => {
    const url = out.toString().split("\n").find((l) => /^https?:\/\//.test(l.trim()));
    if (!url) throw { code: "upstream", message: "yt-dlp returned no url" };
    return url.trim();
  });
}

function mp3(input: string | Buffer, bin: string, signal?: AbortSignal): Promise<Buffer> {
  const src = typeof input === "string" ? input : "pipe:0";
  return run(
    bin,
    ["-hide_banner", "-loglevel", "error", "-i", src, "-vn",
      "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"],
    typeof input === "string" ? undefined : input,
    signal,
  );
}

const hardErr = (e: unknown) => {
  const c = (e as { code?: unknown })?.code;
  return c === "unknown_source" || c === "provider_unconfigured" || c === "no_providers";
};

export async function audio(
  engine: Engine,
  cfg: Config,
  source: string,
  id: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (source === "spotify") {
    const raw = await dl(
      cfg.spotify,
      id,
      undefined,
      cfg.keyProvider ? null : await device(cfg),
      cfg.keyProvider,
    ).catch((e) => {
      if (e?.code) throw e;
      throw { code: "upstream", message: String(e?.message ?? e) };
    });
    return mp3(raw, cfg.stream.ffmpeg_path, signal);
  }
  let url: string | undefined;
  if (source === "yt" || source === "youtube") {
    url = await ytUrl(id, "audio", cfg.stream.ytdlp_path, signal);
  } else {
    url = ((await engine.strm(source, id).catch((e) => {
      if (hardErr(e)) throw e;
      return null;
    })) as { url?: string } | null)?.url;
    if (!url) {
      const t = (await engine.trk(source, id).catch((e) => {
        if (hardErr(e)) throw e;
        return null;
      })) as { preview_url?: string } | null;
      url = t?.preview_url;
    }
  }
  if (!url) throw { code: "no_stream", message: "no playable stream" };
  if (!/^https?:\/\//.test(url)) throw { code: "upstream", message: "bad stream url" };
  return mp3(url, cfg.stream.ffmpeg_path);
}

const ACACHE_MAX = 96 * 1024 * 1024;
const ACACHE_TTL = 10 * 60_000;
const acache = new Map<string, { buf: Buffer; exp: number }>();
const doing = new Map<string, { p: Promise<Buffer>; ctl: AbortController; refs: number }>();

export function cachedAudio(
  engine: Engine,
  cfg: Config,
  source: string,
  id: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const key = `${source}:${id}`;
  const now = Date.now();
  for (const [k, v] of acache) {
    if (v.exp <= now) acache.delete(k);
    else if (k === key) {
      acache.delete(k);
      acache.set(k, v);
      return Promise.resolve(v.buf);
    }
  }
  let d = doing.get(key);
  if (!d) {
    const ctl = new AbortController();
    const p = audio(engine, cfg, source, id, ctl.signal)
      .then((buf) => {
        if (buf.length <= ACACHE_MAX) {
          let total = buf.length;
          for (const v of acache.values()) total += v.buf.length;
          for (const [k, v] of acache) {
            if (total <= ACACHE_MAX) break;
            acache.delete(k);
            total -= v.buf.length;
          }
          acache.set(key, { buf, exp: Date.now() + ACACHE_TTL });
        }
        return buf;
      })
      .finally(() => doing.delete(key));
    d = { p, ctl, refs: 0 };
    doing.set(key, d);
  }
  d.refs++;
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    if (--d.refs <= 0) {
      doing.delete(key);
      d.ctl.abort();
    }
  };
  signal?.addEventListener("abort", drop, { once: true });
  return d.p.finally(() => {
    signal?.removeEventListener("abort", drop);
    drop();
  });
}
