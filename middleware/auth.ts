import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../shared/config.ts";
import { out } from "../shared/http.ts";

function ipOk(cfg: Config, req: IncomingMessage): boolean {
  const { ips } = cfg.auth;
  if (!ips.length) return true;
  const addr = req.socket.remoteAddress ?? "";
  const ip = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return ips.includes(ip === "::1" ? "127.0.0.1" : ip);
}

export function gate(cfg: Config, req: IncomingMessage, res: ServerResponse): boolean {
  const { token } = cfg.auth;
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) {
    out(res, 400, { error: { code: "bad_request", message: "malformed request target" } });
    return false;
  }
  if (url.pathname === "/healthz") return true;
  if (!token && !cfg.auth.ips.length) return true;
  if (!ipOk(cfg, req)) {
    out(res, 403, { error: { code: "forbidden", message: "ip not allowed" } });
    return false;
  }
  if (token) {
    const t =
      url.searchParams.get("tkn") ?? url.searchParams.get("key") ?? req.headers["x-api-key"];
    if (t !== token) {
      out(res, 401, { error: { code: "unauthorized", message: "missing or bad token" } });
      return false;
    }
  }
  return true;
}
