import { fail, out, type Route } from "../shared/http.ts";
import { readBody, safeFetch } from "../shared/egress.ts";

const HOSTS = [
  "mzstatic.com",
  "scdn.co",
  "sndcdn.com",
  "ytimg.com",
  "ggpht.com",
  "googleusercontent.com",
];

const CAP = 8 * 1024 * 1024;

const hostOk = (u: URL) =>
  HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));

export function img(): Route {
  return {
    method: "GET",
    pattern: new URLPattern({ pathname: "/v1/img/:b64" }),
    async handler(_req, res, params) {
      let u: URL | null;
      try {
        u = new URL(Buffer.from(params.b64!, "base64url").toString());
      } catch {
        u = null;
      }
      if (
        !u ||
        u.protocol !== "https:" ||
        !HOSTS.some((h) => u!.hostname === h || u!.hostname.endsWith("." + h))
      ) {
        return out(res, 400, {
          error: { code: "bad_url", message: "not an allowed image url" },
        });
      }
      try {
        const r = await safeFetch(
          u.toString(),
          { signal: AbortSignal.timeout(15_000) },
          { hosts: hostOk },
        );
        if (!r.ok) {
          return out(res, r.status === 404 ? 404 : 502, {
            error: { code: "upstream", message: `image upstream ${r.status}` },
          });
        }
        const buf = await readBody(r, CAP);
        if (!buf) {
          return out(res, 502, { error: { code: "upstream", message: "image too large" } });
        }
        res.writeHead(200, {
          "Content-Type": r.headers.get("content-type") ?? "image/jpeg",
          "Content-Length": buf.length,
          "Cache-Control": "public, max-age=86400",
        });
        res.end(buf);
      } catch (e) {
        fail(res, e);
      }
    },
  };
}
