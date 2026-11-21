import type { IncomingMessage, ServerResponse } from "node:http";
import { EngineError } from "./engine.ts";

export interface Route {
  method: string;
  pattern: URLPattern;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string | undefined>,
    query: URLSearchParams,
  ) => Promise<void> | void;
}

export function out(res: ServerResponse, status: number, v: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(v));
}

export function bind(a: string): { host?: string; port: number } {
  const m = /^(?:(.*):)?(\d+)$/.exec(a);
  return { host: m?.[1] || undefined, port: Number(m?.[2]) || 9981 };
}

const SRC_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ID_RE = /^[\w:.~+@-]{1,256}$/;

export function checkSource(s: string) {
  if (!SRC_RE.test(s)) throw { code: "invalid_id", message: "invalid source" };
}

export function checkId(s: string) {
  if (!ID_RE.test(s)) throw { code: "invalid_id", message: "invalid id" };
}

const statusByCode: Record<string, number> = {
  missing_query: 400,
  missing_params: 400,
  unknown_source: 400,
  invalid_id: 400,
  bad_url: 400,
  not_found: 404,
  no_stream: 404,
  busy: 503,
  provider_unconfigured: 503,
  widevine_cdm_unavailable: 501,
  no_providers: 503,
  ytdlp_missing: 501,
  unsupported: 501,
  upstream: 502,
  upstream_error: 502,
  resolve_failed: 502,
};

export function fail(res: ServerResponse, e: unknown) {
  const code = e instanceof EngineError ? e.code : (e as { code?: unknown })?.code;
  if (typeof code === "string") {
    const message =
      e instanceof Error ? e.message : ((e as { message?: unknown })?.message ?? code);
    out(res, statusByCode[code] ?? 500, { error: { code, message: String(message) } });
    return;
  }
  console.error(e);
  out(res, 500, { error: { code: "internal", message: "internal error" } });
}
