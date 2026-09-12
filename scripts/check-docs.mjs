import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
const zh = readdirSync("doc/zh-CN").sort();
const en = readdirSync("doc/en").sort();
assert.deepEqual(
  zh,
  en,
  "Document languages must use matching numbered filenames",
);
assert.deepEqual(
  zh.map((name) => name.slice(0, 2)),
  ["01", "02", "03", "04", "05", "06", "07"],
);
const files = [
  "README.md",
  "README.en.md",
  "doc/README.md",
  ...zh.map((file) => `doc/zh-CN/${file}`),
  ...en.map((file) => `doc/en/${file}`),
];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert.ok(
      existsSync(resolve(dirname(file), target)),
      `${file}: broken link ${target}`,
    );
  }
}
console.log("Paired documents 01–07 and README links verified.");
