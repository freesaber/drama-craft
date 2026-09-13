import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
const zh = readdirSync("doc/zh-CN").sort();
const en = readdirSync("doc/en").sort();
assert.deepEqual(
  zh.map((name) => name.slice(0, 2)),
  en.map((name) => name.slice(0, 2)),
  "Document languages must use matching document numbers",
);
assert.deepEqual(
  zh.map((name) => name.slice(0, 2)),
  ["01", "02", "03", "04", "05", "06", "07", "08"],
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
  const links = [];
  visit(unified().use(remarkParse).parse(text), "link", (node) =>
    links.push(node.url),
  );
  for (const link of links) {
    const target = link.split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert.ok(
      existsSync(resolve(dirname(file), target)),
      `${file}: broken link ${target}`,
    );
  }
}
console.log("Paired documents 01–08 and README links verified.");
