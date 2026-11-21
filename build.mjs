import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const id = Date.now().toString(36);
mkdirSync(".Out", { recursive: true });

execSync("go build ./...", { stdio: "inherit" });

const goroot = execSync("go env GOROOT").toString().trim();
cpSync(`${goroot}/lib/wasm/wasm_exec.js`, ".Out/wasm_exec.js");

for (const f of readdirSync(".Out")) {
  if (f.startsWith("build-") && f.endsWith(".wasm")) rmSync(`.Out/${f}`);
}

execSync(`go build -o .Out/build-${id}.wasm ./internal/wasm`, {
  stdio: "inherit",
  env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
});

console.log(`built .Out/build-${id}.wasm`);
