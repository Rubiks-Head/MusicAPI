import { createInterface } from "node:readline/promises";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadCfg, setCfg, cdmReady } from "./shared/config.ts";
import {
  devauth,
  poll,
  checkdc,
  paired,
} from "./shared/spotify.ts";

const CONFIG = "config.toml";

if (!fs.existsSync(CONFIG)) {
  fs.copyFileSync("config.example.toml", CONFIG);
  console.log(`created ${CONFIG} from example\n`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const cfg = loadCfg(CONFIG);

function open(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawnSync(cmd, args, { stdio: "ignore" });
  } catch {}
}

async function link() {
  const auth = await devauth();
  console.log(`\n  open this link in a browser where you're logged into Spotify:\n`);
  console.log(`    ${auth.verification_uri_complete}\n`);
  console.log(`  code: ${auth.user_code}   (expires in ${Math.round(auth.expires_in / 60)} min)`);
  open(auth.verification_uri_complete);
  console.log("\n  waiting for approval");
  const tok = await poll(auth.device_code, auth.interval, auth.expires_in);
  setCfg(CONFIG, "spotify", "refresh_token", tok.refresh_token);
  console.log("  paired, refresh_token saved to config.toml\n");
}

async function cookie() {
  const dc = (await rl.question("paste sp_dc cookie: ")).trim();
  if (!dc) return;
  process.stdout.write("  validating ");
  const ok = await checkdc(dc).catch(() => false);
  if (!ok) {
    console.log("invalid - cookie did not produce an authenticated session");
    return;
  }
  setCfg(CONFIG, "spotify", "sp_dc", dc);
  console.log("paired, sp_dc saved to config.toml\n");
}

async function browser() {
  const { chromium } = await import("playwright-core").catch(() => ({}));
  if (!chromium) {
    console.log("  playwright-core not installed - run: npm i -D playwright-core");
    return;
  }
  const browser = await chromium
    .launch({ channel: "chrome", headless: false })
    .catch(() => null);
  if (!browser) {
    console.log("  could not launch chrome - is it installed");
    return;
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("https://accounts.spotify.com/login").catch(() => {});
  console.log("  log into spotify in the opened window (waiting up to 4 min)");
  let spdc = null;
  for (let i = 0; i < 120 && !spdc; i++) {
    if (!browser.isConnected()) break;
    const cookies = await ctx.cookies("https://open.spotify.com").catch(() => []);
    spdc = cookies.find((c) => c.name === "sp_dc")?.value ?? null;
    if (!spdc) await new Promise((r) => setTimeout(r, 2000));
  }
  await browser.close().catch(() => {});
  if (!spdc) {
    console.log("  no sp_dc captured - window closed or timed out");
    return;
  }
  setCfg(CONFIG, "spotify", "sp_dc", spdc);
  console.log("  paired, sp_dc saved to config.toml\n");
}

async function spot() {
  if (paired(cfg.spotify)) {
    const a = await rl.question("spotify already paired - re-pair [y/N]: ");
    if (!a.trim() || !/^y/i.test(a.trim())) return;
  }
  console.log("\nspotify pairing:");
  console.log("  1) browser login - chrome opens, you log in once (recommended)");
  console.log("  2) paste sp_dc   - browser cookie from devtools");
  console.log("  3) pair link     - spotify.com/pair (streaming may not work)");
  console.log("  4) skip");
  const c = (await rl.question("choice [1]: ")).trim() || "1";
  if (c === "1") await browser();
  else if (c === "2") await cookie();
  else if (c === "3") await link();
}

console.log("musicapi setup\n");

console.log("automatic providers (no setup needed): soundcloud, apple music, youtube, lrclib\n");

await spot();

const fresh = loadCfg(CONFIG);
console.log("\nsummary:");
console.log(`  spotify:    ${paired(fresh.spotify) ? "paired" : "not paired"}`);
const cdmMsg = cdmReady(fresh)
  ? "ready (device credentials)"
  : "missing - set [cdm] wvd_path or device key files in config.toml";
console.log(`  spotify cdm: ${cdmMsg}`);
console.log(
  `  yt-dlp:     ${fs.existsSync(fresh.stream.ytdlp_path) ? "ready" : "not found - install yt-dlp"}`,
);
console.log(
  `  ffmpeg:     ${fs.existsSync(fresh.stream.ffmpeg_path) ? "ready" : "not found - install ffmpeg"}`,
);
console.log("\ndone - start the api with: node server.ts");

rl.close();
