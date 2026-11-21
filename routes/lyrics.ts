import type { Engine } from "../shared/engine.ts";
import { fail, out, type Route } from "../shared/http.ts";

export function lyr(engine: Engine): Route {
  return {
    method: "GET",
    pattern: new URLPattern({ pathname: "/v1/lyrics" }),
    async handler(_req, res, _params, query) {
      const artist = query.get("artist");
      const track = query.get("track");
      if (!artist || !track) {
        return out(res, 400, {
          error: {
            code: "missing_params",
            message: "query parameters 'artist' and 'track' are required",
          },
        });
      }
      try {
        out(res, 200, await engine.lyr(artist, track));
      } catch (e) {
        fail(res, e);
      }
    },
  };
}
