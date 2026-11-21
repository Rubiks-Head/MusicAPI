import type { Engine } from "../shared/engine.ts";
import { vTrk, vArt, type RawTrack, type RawArtist } from "../shared/enrich.ts";
import { checkId, checkSource, fail, out, type Route } from "../shared/http.ts";

export function lookup(engine: Engine): Route[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/v1/tracks/:source/:id" }),
      async handler(_req, res, params) {
        try {
          checkSource(params.source!);
          checkId(params.id!);
          out(res, 200, vTrk((await engine.trk(params.source!, params.id!)) as RawTrack));
        } catch (e) {
          fail(res, e);
        }
      },
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/v1/artists/:source/:id" }),
      async handler(_req, res, params) {
        try {
          checkSource(params.source!);
          checkId(params.id!);
          out(
            res,
            200,
            vArt((await engine.art(params.source!, params.id!)) as RawArtist),
          );
        } catch (e) {
          fail(res, e);
        }
      },
    },
  ];
}
