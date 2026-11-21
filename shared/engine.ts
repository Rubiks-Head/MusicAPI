import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { Config } from "./config.ts";
import { paired } from "./spotify.ts";

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Engine {
  srch(q: string, source: string, limit: number, offset: number): Promise<unknown>;
  trk(source: string, id: string): Promise<unknown>;
  art(source: string, id: string): Promise<unknown>;
  lyr(artist: string, track: string): Promise<unknown>;
  pl(source: string, id: string): Promise<unknown>;
  strm(source: string, id: string): Promise<unknown>;
  stat(): Promise<unknown>;
}

function call(name: string, ...args: (string | number)[]): Promise<unknown> {
  return (globalThis as any)[name](...args.map(String)).then((s: string) => {
    const env = JSON.parse(s);
    if (!env.ok) throw new EngineError(env.error.code, env.error.message);
    return env.data;
  });
}

export async function loadEng(cfg: Config, outDir = ".Out"): Promise<Engine> {
  createRequire(import.meta.url)(`../${outDir}/wasm_exec.js`);

  const wasm = readdirSync(outDir)
    .filter((f) => f.startsWith("build-") && f.endsWith(".wasm"))
    .sort((a, b) => statSync(`${outDir}/${b}`).mtimeMs - statSync(`${outDir}/${a}`).mtimeMs)[0];
  if (!wasm) throw new Error(`no build-*.wasm in ${outDir} - run: node build.mjs`);

  const go = new (globalThis as any).Go();
  const { instance } = await WebAssembly.instantiate(
    readFileSync(`${outDir}/${wasm}`),
    go.importObject,
  );
  go.run(instance);

  while (!(globalThis as any).__musicReady) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const { addr, stream, spotify, ...engineCfg } = cfg;
  await call("mInit", JSON.stringify({ ...engineCfg, spotify: { paired: paired(spotify) } }));

  return {
    srch: (q, source, limit, offset) => call("mSrch", q, source, limit, offset),
    trk: (source, id) => call("mTrk", source, id),
    art: (source, id) => call("mArt", source, id),
    lyr: (artist, track) => call("mLyr", artist, track),
    pl: (source, id) => call("mPl", source, id),
    strm: (source, id) => call("mStrm", source, id),
    stat: () => call("mStat"),
  };
}
