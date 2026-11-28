"use strict";
const fs = require("fs");
const { execFileSync, spawn } = require("child_process");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }

  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const found = execFileSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (found && fs.existsSync(found)) return found;
    } catch (_) {}
  }

  throw new Error(
    "Chrome/Chromium binary not found. Set CHROME_PATH env var or install Google Chrome / Chromium."
  );
}

/**
 * Launch Headless Chrome bound to an OS-assigned ephemeral CDP port (--remote-debugging-port=0).
 * Eliminates cross-suite CDP port collisions even under concurrent test execution (T01).
 */
function spawnChromeEphemeralCdp({ profileDir, url = "about:blank", windowSize = "1440,900", extraArgs = [] }) {
  const chromeBin = findChrome();
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    ...extraArgs,
    url,
  ];
  const proc = spawn(chromeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stderrBuf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch (_) {}
        reject(new Error("Timed out waiting for Chrome ephemeral CDP port. stderr=" + stderrBuf.slice(-400)));
      }
    }, 15000);

    const onChunk = (chunk) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, cdpPort: Number(m[1]) });
      }
    };
    proc.stderr.on("data", onChunk);
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Chrome exited prematurely (${code}) before CDP port ready. stderr=${stderrBuf.slice(-400)}`));
      }
    });
  });
}

module.exports = { findChrome, spawnChromeEphemeralCdp };
