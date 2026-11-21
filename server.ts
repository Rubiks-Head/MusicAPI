import http from "node:http";
import { loadCfg } from "./shared/config.ts";
import { loadEng } from "./shared/engine.ts";
import { logReq } from "./middleware/log.ts";
import { gate } from "./middleware/auth.ts";
import { bind, fail, out } from "./shared/http.ts";
import { routes } from "./routes/index.ts";

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const cfg = loadCfg("config.toml");
const engine = await loadEng(cfg);
const rs = routes(engine, cfg);

const server = http.createServer(
  logReq(async (req, res) => {
    if (!gate(cfg, req, res)) return;
    const url = URL.parse(req.url ?? "/", "http://localhost");
    if (!url) {
      out(res, 400, { error: { code: "bad_request", message: "malformed request target" } });
      return;
    }
    const method = req.method === "HEAD" ? "GET" : req.method;
    for (const r of rs) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(url.href);
      if (!m) continue;
      try {
        await r.handler(req, res, m.pathname.groups, url.searchParams);
      } catch (e) {
        fail(res, e);
      }
      return;
    }
    out(res, 404, { error: { code: "not_found", message: "route not found" } });
  }),
);

const b = bind(cfg.addr);
server.listen(b.port, b.host, () => console.log(`listening on ${cfg.addr}`));
