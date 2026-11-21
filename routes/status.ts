import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Engine } from "../shared/engine.ts";
import type { Config } from "../shared/config.ts";
import { cdmReady } from "../shared/config.ts";
import { paired } from "../shared/spotify.ts";
import { out, type Route } from "../shared/http.ts";

const xf = promisify(execFile);

async function ytok(path: string): Promise<boolean> {
  try {
    await xf(path, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function stat(engine: Engine, cfg: Config): Route[] {
  let probe = { ytdlp: false };
  const refresh = async () => {
    probe = { ytdlp: await ytok(cfg.stream.ytdlp_path) };
  };
  void refresh();
  setInterval(refresh, 60_000).unref();

  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/healthz" }),
      handler(_req, res) {
        out(res, 200, { status: "ok" });
      },
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/v1/status" }),
      async handler(_req, res) {
        const s = (await engine.stat()) as object;
        out(res, 200, {
          ...s,
          stream: { ytdlp_available: probe.ytdlp },
          spotify: { paired: paired(cfg.spotify), cdm_available: cdmReady(cfg) },
        });
      },
    },
  ];
}
