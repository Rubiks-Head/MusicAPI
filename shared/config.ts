import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
import { Device, type KeyProvider } from "widevine";

export interface Config {
  addr: string;
  domains: Record<string, string>;
  apple: { token: string; storefront: string };
  stream: { ytdlp_path: string; ffmpeg_path: string };
  spotify: { sp_dc: string; refresh_token: string };
  cdm: { wvd_path: string; device_client_id_path: string; device_private_key_path: string };
  auth: { token: string; ips: string[] };
  keyProvider?: KeyProvider;
}

export function bin(name: string): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  if (!exe && name.endsWith(".exe")) {
    const stripped = name.slice(0, -4);
    return existsSync(stripped) ? stripped : name;
  }
  if (exe && !name.endsWith(exe) && !existsSync(name) && existsSync(name + exe)) {
    return name + exe;
  }
  return name;
}

export function loadCfg(path = "config.toml"): Config {
  if (!existsSync(path)) console.warn(`${path} missing - using defaults`);
  const file = existsSync(path) ? (parse(readFileSync(path, "utf8")) as Record<string, any>) : {};
  const stream = { ytdlp_path: "bin/yt-dlp", ffmpeg_path: "bin/ffmpeg", ...(file.stream as object) };
  return {
    addr: (file.addr as string) ?? ":9981",
    domains: {
      soundcloud_api: "https://api-v2.soundcloud.com",
      soundcloud_web: "https://soundcloud.com",
      apple_api: "https://amp-api.music.apple.com/v1",
      apple_web: "https://beta.music.apple.com",
      youtube_web: "https://www.youtube.com",
      lrclib_api: "https://lrclib.net/api",
      spotify_web: "https://open.spotify.com",
      ...(file.domains as object),
    },
    apple: { token: "", storefront: "us", ...(file.apple as object) },
    stream: { ytdlp_path: bin(stream.ytdlp_path), ffmpeg_path: bin(stream.ffmpeg_path) },
    spotify: { sp_dc: "", refresh_token: "", ...(file.spotify as object) },
    cdm: {
      wvd_path: "",
      device_client_id_path: "",
      device_private_key_path: "",
      ...(file.cdm as object),
    },
    auth: { token: "", ips: [] as string[], ...(file.auth as object) },
  };
}

export function cdmReady(cfg: Config): boolean {
  const c = cfg.cdm;
  return Device.ok({
    wvdPath: c.wvd_path,
    clientIdPath: c.device_client_id_path,
    privateKeyPath: c.device_private_key_path,
  });
}

export function setCfg(path: string, section: string, key: string, value: string) {
  const txt = readFileSync(path, "utf8");
  const line = `${key} = "${value}"`;
  const secRe = new RegExp(`(\\[${section}\\][^\\[]*)`, "m");
  const m = txt.match(secRe);
  if (m) {
    const sec = m[1];
    const keyRe = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    const out = keyRe.test(sec)
      ? sec.replace(keyRe, line)
      : sec.replace(/(\[[^\]]+\]\s*)/, `$1${line}\n`);
    writeFileSync(path, txt.replace(secRe, out));
  } else {
    writeFileSync(path, `${txt.replace(/\s*$/, "")}\n\n[${section}]\n${line}\n`);
  }
}
