import type { IncomingMessage, ServerResponse } from "node:http";
import type { Engine } from "../shared/engine.ts";
import type { Config } from "../shared/config.ts";
import { cachedAudio, unmint, ytUrl } from "../shared/audio.ts";
import { checkId, checkSource, fail, out, type Route } from "../shared/http.ts";

function send(req: IncomingMessage, res: ServerResponse, buf: Buffer) {
  const total = buf.length;
  const rh = req.headers.range;
  const m = rh ? /^bytes=(\d*)-(\d*)$/.exec(rh) : null;
  if (m && (m[1] || m[2])) {
    let start: number, end: number;
    if (m[1] === "") {
      const n = parseInt(m[2], 10);
      if (n <= 0) {
        out(res, 416, { error: { code: "bad_range", message: "range not satisfiable" } });
        return;
      }
      start = Math.max(0, total - n);
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    }
    if (isNaN(start) || start > end || start >= total) {
      out(res, 416, { error: { code: "bad_range", message: "range not satisfiable" } });
      return;
    }
    res.writeHead(206, {
      "Content-Type": "audio/mpeg",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    res.end(buf.subarray(start, end + 1));
    return;
  }
  if (rh) {
    out(res, 416, { error: { code: "bad_range", message: "range not satisfiable" } });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Content-Length": total,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(buf);
}

const MAX_JOBS = 4;
const MAX_WAIT = 64;
const WAIT_MS = 60_000;
let live = 0;
const waiters = new Set<() => void>();

function acquire(req: IncomingMessage, res: ServerResponse): Promise<boolean> | boolean {
  if (live < MAX_JOBS) {
    live++;
    return true;
  }
  if (waiters.size >= MAX_WAIT) {
    out(res, 503, { error: { code: "busy", message: "too many queued streams" } });
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(t);
      res.off("close", onClose);
      resolve(ok);
    };
    const w = () => done(true);
    const onClose = () => {
      if (waiters.delete(w)) done(false);
    };
    const t = setTimeout(() => {
      if (waiters.delete(w)) done(false);
    }, WAIT_MS);
    waiters.add(w);
    res.once("close", onClose);
  }).then((ok) => {
    if (!ok && !res.destroyed && !res.writableEnded) {
      out(res, 503, { error: { code: "busy", message: "stream queue wait timed out" } });
    }
    return ok;
  });
}

function release() {
  const w = waiters.values().next().value;
  if (w) {
    waiters.delete(w);
    w();
    return;
  }
  live--;
}

async function job(req: IncomingMessage, res: ServerResponse, work: () => Promise<void>) {
  if (!(await acquire(req, res))) return;
  try {
    await work();
  } finally {
    release();
  }
}

async function serve(
  engine: Engine,
  cfg: Config,
  req: IncomingMessage,
  res: ServerResponse,
  source: string,
  id: string,
) {
  await job(req, res, async () => {
    const ctl = new AbortController();
    res.once("close", () => ctl.abort());
    const buf = await Promise.race([
      cachedAudio(engine, cfg, source, id, ctl.signal),
      new Promise<null>((r) => res.once("close", () => r(null))),
    ]);
    if (buf === null || res.destroyed || res.writableEnded) return;
    send(req, res, buf);
  });
}

export function strm(engine: Engine, cfg: Config): Route[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/v1/audio/:token/file.mp3" }),
      async handler(req, res, params) {
        const t = unmint(params.token!);
        if (!t) {
          return out(res, 404, {
            error: { code: "not_found", message: "unknown audio id" },
          });
        }
        try {
          await serve(engine, cfg, req, res, t.source, t.id);
        } catch (e) {
          fail(res, e);
        }
      },
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/v1/stream/:source/:id" }),
      async handler(req, res, params, query) {
        const { source, id } = params;
        try {
          checkSource(source!);
          checkId(id!);
          if ((source === "yt" || source === "youtube") && query.get("format") === "video") {
            await job(req, res, async () => {
              const ctl = new AbortController();
              res.once("close", () => ctl.abort());
              const loc = await ytUrl(id!, "video", cfg.stream.ytdlp_path, ctl.signal);
              if (res.destroyed || res.writableEnded) return;
              res.writeHead(302, { Location: loc });
              res.end();
            });
            return;
          }
          await serve(engine, cfg, req, res, source!, id!);
        } catch (e) {
          if (!res.destroyed && !res.writableEnded) fail(res, e);
        }
      },
    },
  ];
}
