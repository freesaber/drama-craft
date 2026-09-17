import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "src-tauri", "ffmpeg.lock.json");
const binaries = path.join(root, "src-tauri", "binaries");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const stampPath = path.join(binaries, ".lock-id");
const triple = lock.triple || hostTriple();
const ffmpegDest = path.join(binaries, `ffmpeg-${triple}.exe`);
const ffprobeDest = path.join(binaries, `ffprobe-${triple}.exe`);
const stamp = `${lock.version}:${lock.sha256}:${triple}`;

if (
  existsSync(ffmpegDest) &&
  existsSync(ffprobeDest) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, "utf8").trim() === stamp
) {
  rmSync(path.join(binaries, "ffmpeg-essentials.zip"), { force: true });
  console.log(`FFmpeg ${lock.version} already present.`);
  process.exit(0);
}

const urls = [lock.url, ...(lock.mirrors ?? [])].filter(Boolean);
mkdirSync(binaries, { recursive: true });
const zipPath = path.join(tmpdir(), "dramacraft-ffmpeg-essentials.zip");
const extractDir = path.join(binaries, ".extract");
let lastError = null;
for (const url of urls) {
  try {
    console.log(`Downloading FFmpeg ${lock.version} from ${url}`);
    await download(url, zipPath, url === lock.url ? 120000 : 600000);
    lastError = null;
    break;
  } catch (error) {
    lastError = error;
    console.warn(`Download failed: ${error instanceof Error ? error.message : error}`);
    rmSync(zipPath, { force: true });
  }
}
if (lastError) throw lastError;
const actual = await sha256File(zipPath);
if (actual !== String(lock.sha256).toLowerCase()) {
  rmSync(zipPath, { force: true });
  throw new Error(
    `FFmpeg zip SHA-256 mismatch: expected ${lock.sha256}, got ${actual}`,
  );
}

rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
extractZip(zipPath, extractDir);
const ffmpegSrc = findFile(extractDir, "ffmpeg.exe");
const ffprobeSrc = findFile(extractDir, "ffprobe.exe");
if (!ffmpegSrc || !ffprobeSrc) {
  throw new Error("Zip did not contain ffmpeg.exe and ffprobe.exe");
}
copyFileSync(ffmpegSrc, ffmpegDest);
copyFileSync(ffprobeSrc, ffprobeDest);
const licenseSrc =
  findFile(extractDir, "LICENSE") ?? findFile(extractDir, "LICENSE.txt");
if (licenseSrc) copyFileSync(licenseSrc, path.join(binaries, "LICENSE.ffmpeg"));
writeFileSync(stampPath, stamp);
rmSync(extractDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
console.log(`FFmpeg ${lock.version} installed for ${triple}.`);

function hostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const match = out.match(/host:\s+(\S+)/);
    if (match) return match[1];
  } catch {
    /* use Windows default */
  }
  return "x86_64-pc-windows-msvc";
}

async function download(url, dest, timeoutMs = 600000) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "DramaCraft-ffmpeg-download" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function extractZip(zip, dest) {
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "inherit" });
    return;
  } catch {
    /* Windows fallback */
  }
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" },
  );
}

function findFile(dir, name) {
  const wanted = name.toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === wanted) return full;
    }
  }
  return null;
}
