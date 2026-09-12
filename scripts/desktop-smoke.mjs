// End-to-end checks against the real Tauri executable and Rust filesystem IPC.
// All application interactions use its real UI; tests type explicit temporary paths.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const executable = resolve(
  process.env.DRAMACRAFT_TEST_EXE || "src-tauri/target/debug/drama-craft.exe",
);
await access(executable);
const testRoot = await mkdtemp(join(tmpdir(), "dramacraft-smoke-"));
const profile = join(testRoot, "webview");
const output = resolve("test-results");
await mkdir(output, { recursive: true });
const prefsPath = join(
  process.env.APPDATA,
  "io.dramacraft.desktop",
  "preferences.json",
);
const originalPreferences = await readFile(prefsPath).catch((e) => {
  if (e.code !== "ENOENT") throw e;
  return null;
});
const app = spawn(executable, [], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19420",
    WEBVIEW2_USER_DATA_FOLDER: profile,
  },
  stdio: "ignore",
});
let browser;
let page;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:19420");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(browser, "WebView2 debugging endpoint did not start");
  for (let attempt = 0; attempt < 40; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(page, "No desktop WebView page");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByText("从文字，到每一个镜头。")).toBeVisible();
  await page.screenshot({ path: join(output, "desktop-home.png") });
  await page.getByRole("button", { name: "创建项目", exact: false }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("01 原创 渡口");
  await page.getByLabel("父目录", { exact: false }).fill(testRoot);
  await expect(page.getByLabel("父目录", { exact: false })).toHaveValue(
    testRoot,
  );
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByLabel("Markdown 文档编辑器")).toBeVisible();
  const root = join(testRoot, "01 原创 渡口");
  await access(join(root, ".drama-craft", "project.json"));
  await page.getByRole("button", { name: "新建文档", exact: false }).click();
  await page.getByLabel("文档文件名").fill("01 灯火.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  const editor = page.getByLabel("Markdown 文档编辑器");
  await expect(editor).toContainText("");
  await expect.poll(() => editor.inputValue()).toContain("### 首帧生成");
  const original = await editor.inputValue();
  const edited =
    original.replace("## S001 镜头名", "## S001 点亮渡口") +
    "\n自定义段落：旅人在灯下停步。\n\n[参考图](<参考 图.png>)\n\n`missing.mp4`\n";
  await copyFile("src-tauri/icons/source.png", join(root, "参考 图.png"));
  await editor.fill(edited);
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFile(join(root, "01 灯火.md"), "utf8"))
    .toBe(edited);
  await page
    .getByRole("button", { name: "S001 点亮渡口", exact: false })
    .click();
  assert.equal(
    await editor.evaluate((el) => el.selectionStart),
    edited.indexOf("## S001"),
  );
  await page.screenshot({ path: join(output, "desktop-editor.png") });
  await page.getByRole("button", { name: "素材引用", exact: false }).click();
  await expect(page.getByAltText("参考 图.png")).toBeVisible();
  await expect
    .poll(() =>
      page.getByAltText("参考 图.png").evaluate((image) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByText("文件缺失", { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: join(output, "desktop-assets.png") });
  await page.getByRole("button", { name: "文档预览", exact: true }).click();
  await editor.fill(edited + "\n客户端编辑\n");
  const diskEdit = edited + "\n外部编辑器写入\n";
  await writeFile(join(root, "01 灯火.md"), diskEdit);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText(
      "磁盘文件已改变。编辑内容已保留；请另存为，或重新读取磁盘版本。",
    ),
  ).toBeVisible();
  assert.equal(await readFile(join(root, "01 灯火.md"), "utf8"), diskEdit);
  await expect.poll(() => editor.inputValue()).toContain("客户端编辑");
  await page.screenshot({ path: join(output, "desktop-conflict.png") });
  await page
    .locator(".conflict")
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  await page.getByLabel("文档文件名").fill("01 灯火 保留.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => readFile(join(root, "01 灯火 保留.md"), "utf8").catch(() => '')).toContain("客户端编辑");
  await expect(page.getByRole('dialog')).not.toBeVisible();
  // Clean editor reloads an external modification.
  const changed = "# 外部新内容\n\n## S002 回家\n";
  await writeFile(join(root, "01 灯火 保留.md"), changed);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(editor).toHaveValue(changed);
  // Unsaved navigation is canceled; the editor remains intact.
  await editor.fill(changed + "\n未保存的心愿\n");
  await page.getByRole("button", { name: "返回项目首页", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toHaveValue(changed + "\n未保存的心愿\n");
  await page.getByRole("button", { name: "返回项目首页", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.getByText("从文字，到每一个镜头。")).toBeVisible();
  await page
    .getByRole("button", { name: "打开项目目录", exact: false })
    .click();
  await page.getByLabel("目录路径", { exact: false }).fill(testRoot);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择要打开的作品" }),
  ).toBeVisible();
  await page.getByRole('dialog')
    .getByRole("button", { name: "01 原创 渡口", exact: false })
    .click();
  await expect(editor).toBeVisible();
  // Native close event must be canceled if the dialog is declined.
  await editor.fill("# 未保存退出保护\n");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }),
  );
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toHaveValue("# 未保存退出保护\n");
  // Screenshot the real client at its minimum supported logical window size.
  await page.setViewportSize({ width: 1024, height: 680 });
  await page.screenshot({ path: join(output, "desktop-minimum.png") });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, "Layout overflows minimum window");
  assert.deepEqual(errors, [], "Unhandled frontend errors");
  console.log(
    "PASS: native project creation, editing, Ctrl+S, shot navigation, media, conflict/save-as, refresh, parent candidates and unsaved navigation/close.",
  );
} catch (e) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(output, "desktop-failure.png") })
      .catch(() => {});
  throw e;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill();
    await exited;
  }
  if (originalPreferences) await writeFile(prefsPath, originalPreferences);
  else await rm(prefsPath, { force: true });
  // Only remove the freshly allocated test directory, never a supplied project.
  assert.ok(testRoot.startsWith(join(tmpdir(), "dramacraft-smoke-")));
  await rm(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
}
