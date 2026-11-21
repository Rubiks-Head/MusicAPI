import type { Engine } from "../shared/engine.ts";
import type { Config } from "../shared/config.ts";
import type { Route } from "../shared/http.ts";
import { srch } from "./search.ts";
import { lookup } from "./lookup.ts";
import { lyr } from "./lyrics.ts";
import { pl } from "./playlist.ts";
import { stat } from "./status.ts";
import { strm } from "./stream.ts";
import { img } from "./img.ts";

export function routes(engine: Engine, cfg: Config): Route[] {
  return [
    ...stat(engine, cfg),
    ...srch(engine),
    ...lookup(engine),
    lyr(engine),
    pl(engine),
    ...strm(engine, cfg),
    img(),
  ];
}
