// Regenerates Tauri icon sizes from the committed master image.
// The master is src-tauri/icons/source.png. Do not replace it with a generic play glyph.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = "src-tauri/icons/source.png";
if (!existsSync(source)) {
  console.error("缺少图标原图 src-tauri/icons/source.png");
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["tauri", "icon", source, "--output", "src-tauri/icons"],
  { stdio: "inherit", shell: true },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const icons = "src-tauri/icons";
rmSync(join(icons, "ios"), { recursive: true, force: true });
for (const name of readdirSync(icons)) {
  if (
    name.startsWith("Square") ||
    name === "StoreLogo.png" ||
    name === "icon.png" ||
    name === "64x64.png"
  ) {
    rmSync(join(icons, name), { force: true });
  }
}
const android = join(icons, "android");
if (existsSync(android)) {
  for (const entry of readdirSync(android, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith("mipmap-") &&
      entry.name !== "mipmap-anydpi-v26"
    ) {
      rmSync(join(android, entry.name), { recursive: true, force: true });
    }
  }
}
