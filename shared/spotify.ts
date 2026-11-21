import { createHmac, randomUUID } from "node:crypto";
import { Cdm, Decryptor, decMedia, Device, type KeyProvider } from "widevine";
import { setCfg } from "./config.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.51 Safari/537.36";
const CLIENT_ID = "d8a5ed958d274c2e8ee717e6a4b0971d";
const CONNECT_CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
const ACCOUNTS = "https://accounts.spotify.com";
const OPEN = "https://open.spotify.com";
const SPCLIENT = "https://gue1-spclient.spotify.com";
const DEALER = "wss://dealer.spotify.com";
const SEEKTABLE = "https://seektables.spotifycdn.com";
const CLIENTTOKEN = "https://clienttoken.spotify.com/v1/clienttoken";

const TOTP_SECRET = Buffer.from(
  [...',7/*F("rLJ2oxaKL^f+E1xvP@N'].map((c, i) =>
    String(c.charCodeAt(0) ^ ((i % 33) + 9)),
  ).join(""),
);

function totp(ms: number): number {
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(ms / 1000 / 30)));
  const h = createHmac("sha1", TOTP_SECRET).update(ctr).digest();
  const o = h[19] & 0xf;
  return (h.readUInt32BE(o) & 0x7fffffff) % 1000000;
}

export interface SpotifyCreds {
  sp_dc?: string;
  refresh_token?: string;
}

export function paired(creds: SpotifyCreds): boolean {
  return !!(creds.refresh_token || creds.sp_dc);
}

interface Token {
  accessToken: string;
  isAnonymous: boolean;
  expiresAt: number;
}

let cached: Token | null = null;

async function dctok(spdc: string): Promise<Token> {
  const headers = { "User-Agent": UA, Cookie: `sp_dc=${spdc}` };
  let srv = Date.now();
  try {
    const st = (await (
      await fetch(`${OPEN}/api/server-time`, { headers })
    ).json()) as { serverTime: number };
    srv = Number(st.serverTime) * 1000;
  } catch {}
  const q = new URLSearchParams({
    reason: "transport",
    productType: "web-player",
    totp: String(totp(srv)),
    totpVer: "5",
    ts: String(srv),
  });
  const res = await fetch(`${OPEN}/api/token?${q}`, { headers });
  const d = (await res.json()) as {
    accessToken?: string;
    isAnonymous?: boolean;
    accessTokenExpirationTimestampMs?: number;
  };
  if (!d.accessToken) throw new Error("spotify: token request failed - sp_dc may be invalid");
  return {
    accessToken: d.accessToken,
    isAnonymous: !!d.isAnonymous,
    expiresAt: Number(d.accessTokenExpirationTimestampMs) || Date.now() + 3600_000,
  };
}

async function oauth(creds: SpotifyCreds, configPath: string): Promise<Token> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CONNECT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token!,
    }),
  });
  const d = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!d.access_token)
    throw new Error(`spotify: oauth refresh failed (${d.error ?? res.status}) - re-pair via setup.cli.js`);
  if (d.refresh_token && d.refresh_token !== creds.refresh_token) {
    creds.refresh_token = d.refresh_token;
    try {
      setCfg(configPath, "spotify", "refresh_token", d.refresh_token);
    } catch {}
  }
  return {
    accessToken: d.access_token,
    isAnonymous: false,
    expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000,
  };
}

export async function token(
  creds: SpotifyCreds,
  configPath = "config.toml",
): Promise<Token> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached;
  if (creds.sp_dc) cached = await dctok(creds.sp_dc);
  else if (creds.refresh_token) cached = await oauth(creds, configPath);
  else
    throw {
      code: "provider_unconfigured",
      message: "spotify: not paired - run: node setup.cli.js",
    };
  return cached;
}

export async function checkdc(spdc: string): Promise<boolean> {
  const t = await dctok(spdc);
  return !t.isAnonymous;
}

export interface DeviceAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function devauth(): Promise<DeviceAuth> {
  const res = await fetch(`${ACCOUNTS}/oauth2/device/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CONNECT_CLIENT_ID, scope: "streaming" }),
  });
  if (!res.ok) throw new Error(`spotify: device authorize ${res.status}`);
  return (await res.json()) as DeviceAuth;
}

export async function poll(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<{ access_token: string; refresh_token: string }> {
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CONNECT_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }),
    });
    const d = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
    };
    if (d.access_token && d.refresh_token)
      return { access_token: d.access_token, refresh_token: d.refresh_token };
    if (d.error === "authorization_pending") {
      await new Promise((r) => setTimeout(r, interval * 1000));
      continue;
    }
    throw new Error(`spotify: pairing failed (${d.error ?? res.status})`);
  }
  throw new Error("spotify: pairing link expired - run setup again");
}

async function cltok(): Promise<string> {
  const res = await fetch(CLIENTTOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({
      client_data: { client_version: "1.2.0", client_id: CLIENT_ID, js_sdk_data: {} },
    }),
  });
  const d = (await res.json()) as { granted_token?: { token: string } };
  if (!d.granted_token?.token) throw new Error(`spotify: clienttoken ${res.status}`);
  return d.granted_token.token;
}

let cachedCert: Buffer | null = null;

async function appcert(token: string): Promise<Buffer> {
  if (cachedCert) return cachedCert;
  const res = await fetch(`${SPCLIENT}/widevine-license/v1/application-certificate`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`spotify: service cert ${res.status}`);
  cachedCert = Buffer.from(await res.arrayBuffer());
  return cachedCert;
}

class Sock {
  private queue: string[] = [];
  private waiter: ((s: string) => void) | null = null;
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const s = typeof e.data === "string" ? e.data : "";
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(s);
      } else this.queue.push(s);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("dealer ws connect failed")), {
        once: true,
      });
    });
  }

  recv(ms: number): Promise<unknown> {
    const p = this.queue.length
      ? Promise.resolve(this.queue.shift()!)
      : new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => {
            this.waiter = null;
            reject(new Error("dealer ws timeout"));
          }, ms);
          this.waiter = (s) => {
            clearTimeout(t);
            resolve(s);
          };
        });
    return p.then((s) => JSON.parse(s));
  }

  close() {
    this.ws.close();
  }
}

export function uri(ref: string): string {
  if (ref.startsWith("spotify:track:")) return ref;
  if (ref.includes("open.spotify.com/track/"))
    return `spotify:track:${ref.split("/track/")[1].split("?")[0]}`;
  return `spotify:track:${ref}`;
}

export function tid(ref: string): string {
  return uri(ref).split(":")[2];
}

interface Session {
  token: string;
  ctok: string;
}

async function sess(creds: SpotifyCreds): Promise<Session> {
  const [t, ctok] = await Promise.all([token(creds), cltok()]);
  return { token: t.accessToken, ctok };
}

function req(s: Session, url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${s.token}`,
      "client-token": s.ctok,
      "User-Agent": UA,
      Origin: OPEN,
      Referer: `${OPEN}/`,
      ...(init.headers as object),
    },
  });
}

interface Push {
  fileId?: string;
  machineId?: string;
  stateId?: string;
}

async function arm(s: Session, uri: string): Promise<{ fid: string; dev: string }> {
  const sock = new Sock(`${DEALER}/?access_token=${s.token}`);
  await sock.open();
  try {
    const hello = (await sock.recv(10_000)) as { headers?: Record<string, string> };
    const connId = hello.headers?.["Spotify-Connection-Id"];
    if (!connId) throw new Error("dealer: no connection id");
    const dev = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "").slice(0, 8);
    const reg = {
      device: {
        brand: "spotify",
        capabilities: {
          change_volume: true,
          enable_play_token: true,
          supports_file_media_type: true,
          play_token_lost_behavior: "pause",
          disable_connect: false,
          audio_podcasts: true,
          video_playback: true,
          manifest_formats: [
            "file_ids_mp3",
            "file_urls_mp3",
            "manifest_urls_audio_ad",
            "manifest_ids_video",
            "file_urls_external",
            "file_ids_mp4_dual",
            "file_ids_mp4",
            "manifest_urls_audio_ad",
          ],
          supports_preferred_media_type: true,
          supports_playback_offsets: true,
          supports_playback_speed: true,
        },
        device_id: dev,
        device_type: "computer",
        metadata: {},
        model: "web_player",
        name: "web player (chrome)",
        platform_identifier: "web_player windows 10;chrome 157.0.0.0;desktop",
        is_group: false,
        is_public: false,
        correlation_id: randomUUID(),
        client_version: "harmony:4.81.1-1f3d48b7f",
      },
      outro_endcontent_snooping: false,
      connection_id: connId,
      client_version: "harmony:4.81.1-1f3d48b7f",
      volume: 65535,
    };
    const rr = await req(s, `${SPCLIENT}/track-playback/v1/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reg),
    });
    if (!rr.ok) throw new Error(`spotify: device register ${rr.status}`);
    const cmd = {
      command: {
        endpoint: "play",
        context: { uri: uri, url: `context://${uri}`, metadata: {} },
        options: { license: "on-demand", skip_to: { track_index: 0 } },
        logging_params: {
          command_id: randomUUID().replaceAll("-", ""),
          page_instance_ids: [],
          interaction_ids: [],
        },
        play_origin: {
          feature_identifier: "harmony",
          feature_version: "4.81.1",
          view_uri: "",
          external_referrer: "",
          referrer_identifier: "",
          device_identifier: "",
        },
        playback_params: {},
      },
    };
    const pr = await req(
      s,
      `${SPCLIENT}/connect-state/v1/player/command/from/${dev}/to/${dev}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) },
    );
    if (!pr.ok) throw new Error(`spotify: play command ${pr.status}`);
    const push: Push = {};
    let fallbackFid: string | undefined;
    const fidOf = (t: any): string | undefined => {
      for (const [grp, list] of Object.entries<any[]>(t?.manifest ?? {}))
        for (const e of list)
          if (e?.track_type === "AUDIO" && e?.file_id && grp.includes("mp4_dual")) return e.file_id;
    };
    for (let i = 0; i < 10 && !push.fileId; i++) {
      let m: any;
      try {
        m = await sock.recv(15_000);
      } catch {
        break;
      }
      for (const p of m?.payloads ?? []) {
        const sm = p.state_machine ?? {};
        const tracks = sm.tracks ?? [];
        const states = sm.states ?? [];
        const sidx = p.state_ref?.state_index ?? 0;
        const want = tracks.findIndex(
          (t: any) => t?.metadata?.uri === uri || t?.metadata?.linked_from_uri === uri,
        );
        const ti = want >= 0 ? want : Math.min(sidx, tracks.length - 1);
        const fid = ti >= 0 ? fidOf(tracks[ti]) : undefined;
        if (sm.state_machine_id) push.machineId = sm.state_machine_id;
        if (states[sidx]?.state_id) push.stateId = states[sidx].state_id;
        if (fid && want >= 0) {
          push.fileId = fid;
          break;
        }
        if (fid) fallbackFid = fallbackFid ?? fid;
      }
    }
    push.fileId = push.fileId ?? fallbackFid;
    if (!push.fileId) throw new Error("spotify: no file_id - track may be unavailable");
    await req(s, `${SPCLIENT}/track-playback/v1/devices/${dev}/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seq_num: 1,
        state_ref: {
          state_machine_id: push.machineId,
          state_id: push.stateId || dev,
          paused: false,
        },
        sub_state: {
          playback_speed: 0,
          position: 0,
          duration: 213560,
          media_type: "AUDIO",
          bitrate: 128000,
          audio_quality: "HIGH",
          format: 12,
          is_video_on: false,
        },
        debug_source: "before_track_load",
      }),
    });
    return { fid: push.fileId, dev };
  } finally {
    sock.close();
  }
}

export async function dl(
  creds: SpotifyCreds,
  ref: string,
  cdm?: Cdm,
  dev?: Device | null,
  keyProvider?: KeyProvider,
): Promise<Buffer> {
  const s = await sess(creds);
  const { fid } = await arm(s, uri(ref));

  if (keyProvider) {
    const resolve = await req(
      s,
      `${SPCLIENT}/storage-resolve/v2/files/audio/interactive/12/${fid}`,
    );
    if (!resolve.ok) throw new Error(`spotify: storage-resolve ${resolve.status}`);
    const pb = Buffer.from(await resolve.arrayBuffer());
    const cdn = pb.toString("latin1").match(/https:\/\/[\x20-\x7e]+/)?.[0];
    if (!cdn) throw new Error("spotify: no cdn url in storage-resolve");
    const mediaRes = await fetch(cdn);
    if (!mediaRes.ok) throw new Error(`spotify: cdn ${mediaRes.status}`);
    const media = Buffer.from(await mediaRes.arrayBuffer());
    let kid = Buffer.from(fid.slice(0, 32), "hex");
    const tenc = media.indexOf("tenc");
    if (tenc > 0) kid = media.subarray(tenc + 12, tenc + 28);
    if (tenc < 0 && !kid.length) throw new Error("spotify: no key id");
    return await decMedia(media, new Decryptor(keyProvider), kid);
  }

  let own = false;
  if (!cdm) {
    if (!dev) {
      throw {
        code: "widevine_device_unavailable",
        message:
          "widevine decryption needs device credentials - set [cdm] wvd_path or " +
          "device_client_id_path + device_private_key_path in config.toml",
      };
    }
    cdm = await Cdm.open(dev);
    own = true;
  }

  const [cert, seekRes] = await Promise.all([
    appcert(s.token),
    req(s, `${SEEKTABLE}/v1/seektable/${fid}`),
  ]);
  if (!seekRes.ok) throw new Error(`spotify: seektable ${seekRes.status}`);
  const seek = (await seekRes.json()) as { pssh?: { widevine?: string } };
  if (!seek.pssh?.widevine) throw new Error("spotify: no widevine pssh in seektable");

  try {
    await cdm.cert(cert);
    const chal = await cdm.chal(seek.pssh.widevine);
    const lic = await req(s, `${SPCLIENT}/widevine-license/v1/audio/license`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(chal),
    });
    if (!lic.ok) throw new Error(`spotify: license ${lic.status}`);
    await cdm.upd(Buffer.from(await lic.arrayBuffer()));
    const resolve = await req(
      s,
      `${SPCLIENT}/storage-resolve/v2/files/audio/interactive/12/${fid}`,
    );
    if (!resolve.ok) throw new Error(`spotify: storage-resolve ${resolve.status}`);
    const pb = Buffer.from(await resolve.arrayBuffer());
    const cdn = pb.toString("latin1").match(/https:\/\/[\x20-\x7e]+/)?.[0];
    if (!cdn) throw new Error("spotify: no cdn url in storage-resolve");
    const mediaRes = await fetch(cdn);
    if (!mediaRes.ok) throw new Error(`spotify: cdn ${mediaRes.status}`);
    const media = Buffer.from(await mediaRes.arrayBuffer());
    let kid = Buffer.from(fid.slice(0, 32), "hex");
    const tenc = media.indexOf("tenc");
    if (tenc > 0) kid = media.subarray(tenc + 12, tenc + 28);
    if (tenc < 0 && !kid.length) throw new Error("spotify: no key id");
    return await decMedia(media, cdm, kid);
  } finally {
    if (own) cdm.close();
  }
}
