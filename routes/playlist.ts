import type { Engine } from "../shared/engine.ts";
import { vPl, type RawPlaylist } from "../shared/enrich.ts";
import { checkId, checkSource, fail, out, type Route } from "../shared/http.ts";

export function pl(engine: Engine): Route {
  return {
    method: "GET",
    pattern: new URLPattern({ pathname: "/v1/playlists/:source/:id" }),
    async handler(_req, res, params) {
      try {
        checkSource(params.source!);
        checkId(params.id!);
        out(
          res,
          200,
          vPl((await engine.pl(params.source!, params.id!)) as RawPlaylist),
        );
      } catch (e) {
        fail(res, e);
      }
    },
  };
}
