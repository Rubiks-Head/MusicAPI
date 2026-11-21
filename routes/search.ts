import type { Engine } from "../shared/engine.ts";
import { vTrk, vArt, type RawTrack, type RawArtist } from "../shared/enrich.ts";
import { checkSource, fail, out, type Route } from "../shared/http.ts";

interface SearchBody {
  query?: string;
  tracks?: RawTrack[];
  artists?: RawArtist[];
  errors?: Record<string, string>;
}

function h(engine: Engine): Route["handler"] {
  return async (_req, res, params, query) => {
    const q = query.get("q");
    if (!q) {
      return out(res, 400, {
        error: { code: "missing_query", message: "query parameter 'q' is required" },
      });
    }
    const limit = Math.min(Math.max(Number(query.get("limit")) || 10, 1), 25);
    const pg = Math.min(Math.max(Number(query.get("pg")) || 1, 1), 10);
    const source = params?.source ?? query.get("source") ?? "";
    try {
      if (source) checkSource(source);
      const body = (await engine.srch(q, source, limit, (pg - 1) * limit)) as SearchBody;
      const path = source ? `/v1/search/${source}/` : "/v1/search/";
      const qs = `q=${encodeURIComponent(q)}&limit=${limit}`;
      const hasResults = (body.tracks?.length ?? 0) + (body.artists?.length ?? 0) > 0;
      out(res, 200, {
        query: body.query ?? q,
        page: pg,
        tracks: (body.tracks ?? []).map(vTrk),
        artists: (body.artists ?? []).map(vArt),
        next: pg < 10 && hasResults ? `${path}?${qs}&pg=${pg + 1}` : null,
        ...(body.errors ? { errors: body.errors } : {}),
        powered_by: "powered by Rubik's Head <3, made by Roadsign (road.ts)",
      });
    } catch (e) {
      fail(res, e);
    }
  };
}

export function srch(engine: Engine): Route[] {
  const fn = h(engine);
  return [
    { method: "GET", pattern: new URLPattern({ pathname: "/v1/search" }), handler: fn },
    { method: "GET", pattern: new URLPattern({ pathname: "/v1/search/" }), handler: fn },
    { method: "GET", pattern: new URLPattern({ pathname: "/v1/search/:source" }), handler: fn },
    { method: "GET", pattern: new URLPattern({ pathname: "/v1/search/:source/" }), handler: fn },
  ];
}
