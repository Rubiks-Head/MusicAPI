import type { IncomingMessage, ServerResponse } from "node:http";
import { out } from "../shared/http.ts";

export function logReq(
  next: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();
    res.on("finish", () => {
      const path = URL.parse(req.url ?? "/", "http://x")?.pathname ?? req.url ?? "/";
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    try {
      await next(req, res);
    } catch (e) {
      console.error(e);
      if (res.headersSent) res.destroy();
      else out(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  };
}
