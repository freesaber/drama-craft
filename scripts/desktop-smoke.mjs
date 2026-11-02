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
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const executable = resolve(
  process.env.DRAMACRAFT_TEST_EXE || "src-tauri/target/debug/drama-craft.exe",
);
const debugPort = Number(process.env.DRAMACRAFT_TEST_PORT || "19420");
await access(executable);
const testRoot = await mkdtemp(join(tmpdir(), "dramacraft-smoke-"));
const voiceLibrary = join(testRoot, "测试声音库");
await mkdir(voiceLibrary);
await writeFile(join(voiceLibrary, "旁白.wav"), "synthetic-audio");
const legacyRoot = join(testRoot, "02 旧项目");
await mkdir(legacyRoot);
await writeFile(join(legacyRoot, "01 旧剧本.md"), "# 旧剧本\n");
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
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    WEBVIEW2_USER_DATA_FOLDER: profile,
  },
  stdio: "ignore",
});
let browser;
let page;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
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
  await page.locator(".start-card", { hasText: "打开项目目录" }).click();
  await page.getByLabel("目录路径", { exact: false }).fill(legacyRoot);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "配置角色与声音" }),
  ).toBeVisible();
  await page
    .getByLabel("声音目录（必选）", { exact: false })
    .fill(voiceLibrary);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await access(join(legacyRoot, ".drama-craft", "project.json"));
  await page.getByRole("button", { name: "返回项目首页", exact: true }).click();
  await page.getByRole("button", { name: "创建项目", exact: false }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("01 原创 渡口");
  await page.getByLabel("父目录", { exact: false }).fill(testRoot);
  await expect(page.getByLabel("父目录", { exact: false })).toHaveValue(
    testRoot,
  );
  await page
    .getByLabel("声音目录（必选）", { exact: false })
    .fill(voiceLibrary);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.locator(".board-document").first()).toBeVisible();
  await expect(page.getByLabel("Markdown 文档编辑器")).not.toBeVisible();
  const root = join(testRoot, "01 原创 渡口");
  await access(join(root, ".drama-craft", "project.json"));
  await page.getByRole("button", { name: "▤ AGENTS.md", exact: true }).click();
  await expect(
    page.locator(".board-document summary", { hasText: "素材引用" }),
  ).toHaveCount(0);
  await expect(
    page.locator('.markdown-body input[type="checkbox"]'),
  ).toHaveCount(0);
  const checklistItem = page
    .locator(".markdown-body li", { hasText: /^标准 Markdown/ })
    .first();
  await expect(checklistItem).toBeVisible();
  assert.equal(
    await checklistItem.evaluate(
      (item) => getComputedStyle(item).listStyleType,
    ),
    "disc",
  );
  await page.getByRole("button", { name: "▤ 剧本大纲.md", exact: true }).click();
  assert.ok(
    (
      await readFile(join(root, ".drama-craft", "project.json"), "utf8")
    ).includes(voiceLibrary.replaceAll("\\", "\\\\")),
  );
  const episodeDocument = `<!-- drama-craft:episode:v1 -->

# 第0001集 灯火

本集内容：

## 角色绑定

| 角色ID | 名称 | 角色图 | 音色文件 |
|---|---|---|---|

## 本集使用素材

| 素材ID | 名称 | 类型 | 文件 |
|---|---|---|---|

## 本集声音安排

| 镜号 | 角色ID | 角色名称 | 台词 |
|---|---|---|---|

## S001 镜头名

角色：—

### 故事走向

### 首帧生成

出图文件名：\`0001 首帧_S001.png\`。

**首帧图片提示词**

\`\`\`text
在此描述动作开始前的静态画面。
\`\`\`

### 视频生成

视频文件名：\`0001 S001.mp4\`。

| API参数 | 提示词标签 | 上传素材 |
|---|---|---|
| \`ref_image_0\` | \`<Picture 1>\` | \`0001 首帧_S001.png\` |

**视频提示词｜duration=5，resolution=480p横**

\`\`\`text
<Picture 1> is the first frame of [Shot 1].

detailed_description:
The target video uses [replace with the visual style confirmed with the user, written in concise English]. Maintain that style and the rendering of <Picture 1> throughout the video.

[Shot 1] The shot begins from <Picture 1>, preserving its scene, lighting, and opening composition.
在此描述动作、摄影机行为与声音。

overall_soundscape:
[用简短英文描述持续环境声。]

non_diegetic_music:
N/A
\`\`\`
`;
  // Structural document creation is performed outside the client.
  await writeFile(join(root, "01 灯火.md"), episodeDocument);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("button", { name: "▤ 01 灯火.md", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "新建文档", exact: false }),
  ).toHaveCount(0);
  const firstCard = () => page.locator(".shot-card").first();
  const toSource = async () =>
    page
      .locator(".mode-switch")
      .getByRole("button", { name: "Markdown 源码", exact: true })
      .click();
  const toBoard = async () =>
    page
      .locator(".mode-switch")
      .getByRole("button", { name: "故事板", exact: true })
      .click();
  // Fixed-format data is displayed as bound character cards, not Markdown tables.
  await copyFile("src-tauri/icons/source.png", join(root, "角色 图.png"));
  const silentVoice = Buffer.alloc(44 + 1600);
  silentVoice.write("RIFF", 0);
  silentVoice.writeUInt32LE(silentVoice.length - 8, 4);
  silentVoice.write("WAVEfmt ", 8);
  silentVoice.writeUInt32LE(16, 16);
  silentVoice.writeUInt16LE(1, 20);
  silentVoice.writeUInt16LE(1, 22);
  silentVoice.writeUInt32LE(8000, 24);
  silentVoice.writeUInt32LE(16000, 28);
  silentVoice.writeUInt16LE(2, 32);
  silentVoice.writeUInt16LE(16, 34);
  silentVoice.write("data", 36);
  silentVoice.writeUInt32LE(1600, 40);
  await writeFile(join(root, "角色 声音.wav"), silentVoice);
  await toSource();
  const setupEditor = page.getByLabel("Markdown 文档编辑器");
  await setupEditor.fill(
    (await setupEditor.inputValue())
      .replace(
        "|---|---|---|---|",
        "|---|---|---|---|\n| C001 | 旅人 | `角色 图.png` | `角色 声音.wav` |",
      )
      .replace(
        "## 本集使用素材\n\n| 素材ID | 名称 | 类型 | 文件 |\n|---|---|---|---|",
        "## 本集使用素材\n\n| 素材ID | 名称 | 类型 | 文件 |\n|---|---|---|---|\n| A001 | 渡口 | 场景 | — |\n\n### 渡口\n\n```text\n晨雾中的古渡口，木码头延伸到水面。\n```",
      )
      .replace("角色：—", "角色：C001"),
  );
  await toBoard();
  await expect(page.locator(".storyboard-scroll .markdown-body")).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: /角色/ }).click();
  const boundRole = page.locator(
    '.episode-material-card[data-character-id="C001"]',
  );
  await boundRole.scrollIntoViewIfNeeded();
  await expect(boundRole.getByAltText("角色 图.png")).toBeVisible();
  await expect(boundRole.locator("audio")).toBeVisible();
  await boundRole.click();
  const rolePreview = page.getByRole("dialog", { name: "旅人", exact: true });
  await expect(
    rolePreview.getByRole("tab", { name: "大图", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(rolePreview.getByAltText("角色 图.png")).toBeVisible();
  const imageBounds = await rolePreview.boundingBox();
  await rolePreview
    .getByRole("tab", { name: "生成提示词", exact: true })
    .click();
  assert.deepEqual(await rolePreview.boundingBox(), imageBounds);
  await rolePreview.getByRole("button", { name: "确认", exact: true }).click();
  await page.screenshot({
    path: join(output, "desktop-character-binding.png"),
  });
  await page
    .locator(".episode-overview")
    .getByRole("tab", { name: /素材/ })
    .click();
  await page.getByRole("button", { name: /渡口/ }).click();
  const materialPrompt = page.getByRole("dialog", {
    name: "渡口",
    exact: true,
  });
  await expect(materialPrompt).toContainText("暂无可预览的图片");
  const missingImageBounds = await materialPrompt.boundingBox();
  await materialPrompt
    .getByRole("tab", { name: "生成提示词", exact: true })
    .click();
  assert.deepEqual(await materialPrompt.boundingBox(), missingImageBounds);
  await expect(materialPrompt).toContainText(
    "晨雾中的古渡口，木码头延伸到水面。",
  );
  await page.screenshot({
    path: join(output, "desktop-missing-material-prompt.png"),
  });
  await materialPrompt.getByRole("button", { name: "确认" }).click();
  await expect(firstCard()).toBeVisible();
  await expect(
    firstCard().getByRole("button", { name: "生成视频", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "视频 API", exact: true })
    .click();
  await expect(page.getByLabel("API 服务地址", { exact: true })).toBeVisible();
  const tokenInput = page.getByLabel("API Token（Authorization 请求头）", {
    exact: false,
  });
  await expect(tokenInput).toBeVisible();
  await tokenInput.fill("Token synthetic-smoke-test");
  await page.getByRole("button", { name: "显示", exact: true }).click();
  await expect(tokenInput).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏", exact: true }).click();
  await expect(tokenInput).toHaveAttribute("type", "password");
  await tokenInput.fill("");
  const initialProfiles = await page
    .getByLabel("当前使用配置（保存后生效）")
    .locator("option")
    .count();
  await page
    .getByRole("button", { name: "添加 API 配置", exact: true })
    .click();
  await expect(
    page.getByLabel("当前使用配置（保存后生效）").locator("option"),
  ).toHaveCount(initialProfiles + 1);
  await page.getByLabel("配置名称", { exact: true }).fill("备用测试配置");
  await page
    .getByLabel("API 服务地址", { exact: true })
    .fill("https://secondary.example.test");
  await page
    .getByLabel("当前使用配置（保存后生效）")
    .selectOption({ index: 0 });
  await page
    .getByLabel("当前使用配置（保存后生效）")
    .selectOption({ index: initialProfiles });
  await expect(page.getByLabel("API 服务地址", { exact: true })).toHaveValue(
    "https://secondary.example.test",
  );
  await tokenInput.fill("Token synthetic-saved-test");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "视频 API", exact: true })
    .click();
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
    "备用测试配置",
  );
  await expect(page.getByLabel("API 服务地址", { exact: true })).toHaveValue(
    "https://secondary.example.test",
  );
  await expect(
    page.getByLabel("当前使用配置（保存后生效）").locator("option"),
  ).toHaveCount(initialProfiles + 1);
  await expect(tokenInput).toHaveValue("");
  await page.getByRole("button", { name: "显示", exact: true }).click();
  await expect(tokenInput).toHaveValue("Token synthetic-saved-test");
  await expect(tokenInput).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏", exact: true }).click();
  await page.getByRole("button", { name: "删除当前配置", exact: true }).click();
  await expect(
    page.getByLabel("当前使用配置（保存后生效）").locator("option"),
  ).toHaveCount(initialProfiles);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page
    .getByRole("button", { name: "视频 API", exact: true })
    .click();
  await expect(
    page.getByLabel("当前使用配置（保存后生效）").locator("option"),
  ).toHaveCount(initialProfiles);
  await page.screenshot({ path: join(output, "desktop-api-settings.png") });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(firstCard().getByLabel("故事走向", { exact: true })).toHaveCount(
    0,
  );
  await expect(firstCard().locator(".shot-cast")).toHaveCount(0);
  await expect(firstCard().getByLabel("随机种子", { exact: true })).toHaveValue(
    "683072603085674",
  );
  const promptHeight = await firstCard()
    .getByLabel("视频提示词", { exact: true })
    .evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(
    promptHeight >= 415,
    "Video prompt starts at the expanded desktop height",
  );
  await expect(
    firstCard().getByLabel("分辨率", { exact: true }).locator("option"),
  ).toHaveCount(6);
  await firstCard()
    .getByLabel("分辨率", { exact: true })
    .selectOption("480p(1:1)");
  await firstCard().getByLabel("时长（秒）", { exact: true }).selectOption("6");
  const mediaBox = await firstCard().locator(".shot-media").boundingBox();
  const assetBox = await firstCard()
    .locator(".generation-assets")
    .boundingBox();
  assert.ok(assetBox.y >= mediaBox.y + mediaBox.height);
  assert.ok(Math.abs(assetBox.x - mediaBox.x) < 2);
  await firstCard().getByLabel("镜头标题", { exact: true }).fill("灯下相逢");
  await firstCard()
    .getByLabel("视频提示词", { exact: true })
    .fill("旅人点灯。\n\n船夫循光靠岸。");
  // Exercise real keystrokes, including a trailing newline, across reparsing.
  await firstCard().getByLabel("视频提示词", { exact: true }).press("End");
  await firstCard().getByLabel("视频提示词", { exact: true }).press("Enter");
  await firstCard()
    .getByLabel("视频提示词", { exact: true })
    .pressSequentially("灯火未熄。", { delay: 15 });
  await expect(
    firstCard().getByLabel("视频提示词", { exact: true }),
  ).toHaveValue("旅人点灯。\n\n船夫循光靠岸。\n灯火未熄。");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFile(join(root, "01 灯火.md"), "utf8"))
    .toContain("船夫循光靠岸。");
  await expect(
    page.getByRole("button", { name: "新增分镜", exact: false }),
  ).toHaveCount(0);
  await expect(page.locator(".shot-actions button")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "编辑剧集数据", exact: true }),
  ).toHaveCount(0);
  // Adding and removing a card remains possible in Markdown source mode.
  await toSource();
  const structureEditor = page.getByLabel("Markdown 文档编辑器");
  const beforeStructureEdit = await structureEditor.inputValue();
  await structureEditor.fill(
    `${beforeStructureEdit}\n## S002 源码新增\n\n### 故事走向\n\n通过源码调整结构。\n`,
  );
  await toBoard();
  await expect(page.locator(".shot-card")).toHaveCount(2);
  await toSource();
  await structureEditor.fill(beforeStructureEdit);
  await toBoard();
  await expect(page.locator(".shot-card")).toHaveCount(1);
  await toSource();
  const editor = page.getByLabel("Markdown 文档编辑器");
  await expect(editor).toContainText("");
  await expect.poll(() => editor.inputValue()).toContain("### 首帧生成");
  const original = await editor.inputValue();
  assert.ok(original.includes("### 故事走向"));
  const edited =
    original.replace("## S001 灯下相逢", "## S001 点亮渡口") +
    "\n### 创作备注\n\n自定义段落：旅人在灯下停步。\n\n[参考图](<参考 图.png>)\n\n`missing.mp4`\n";
  await copyFile("src-tauri/icons/source.png", join(root, "参考 图.png"));
  await copyFile(
    "src-tauri/icons/source.png",
    join(root, "0001 首帧_S001.png"),
  );
  await writeFile(join(root, "损坏 图片.png"), "synthetic invalid image");
  // Create an original, silent local video fixture using this WebView's encoder.
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start();
    let frame = 0;
    const timer = setInterval(() => {
      context.fillStyle = "#234638";
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = "#efcf83";
      context.fillRect(20 + frame++ * 4, 65, 30, 50);
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, 900));
    clearInterval(timer);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(
      new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      ),
    );
  });
  await writeFile(join(root, "本地样片.webm"), Buffer.from(videoBytes));
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
  await toBoard();
  await firstCard().locator(".generation-thumb").first().click();
  await expect(
    page.locator(".generation-preview .asset-card img"),
  ).toBeVisible();
  await page.locator(".generation-preview .modal-close").click();
  await expect(
    firstCard().getByRole("heading", { name: "首帧图片" }),
  ).toBeVisible();
  await firstCard().getByRole("tab", { name: "提示词", exact: true }).click();
  const framePrompt = firstCard().getByLabel("首帧图片提示词", { exact: true });
  await expect(framePrompt).toBeVisible();
  await framePrompt.fill("横向单幅画面。旅人站在渡口灯下，双手空着。");
  await toSource();
  await expect(editor).toHaveValue(
    /横向单幅画面。旅人站在渡口灯下，双手空着。/,
  );
  await editor.fill(
    (await editor.inputValue()).replace("0001 S001.mp4", "本地样片.webm"),
  );
  await toBoard();
  await firstCard().getByRole("tab", { name: "提示词", exact: true }).click();
  await expect(framePrompt).toHaveValue(
    "横向单幅画面。旅人站在渡口灯下，双手空着。",
  );
  await firstCard().locator(".shot-media").scrollIntoViewIfNeeded();
  const video = firstCard().locator(".shot-media video");
  await video.scrollIntoViewIfNeeded();
  await expect(video).toBeVisible();
  await video.evaluate(async (element) => {
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(0);
  await video.evaluate((element) => element.pause());
  await page.screenshot({ path: join(output, "desktop-assets.png") });
  await firstCard().getByLabel("时长（秒）", { exact: true }).selectOption("8");
  await firstCard()
    .getByLabel("视频提示词", { exact: true })
    .fill("<Picture 1>：灯光映亮面孔。\n旅人转身，看向船夫。");
  await page.setViewportSize({ width: 1024, height: 680 });
  await firstCard().evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  await page.screenshot({
    path: join(output, "desktop-storyboard-minimum.png"),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await firstCard().evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  await page.screenshot({ path: join(output, "desktop-storyboard.png") });
  await toSource();
  await expect(editor).toHaveValue(/duration=8/);
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
  await expect
    .poll(() => readFile(join(root, "01 灯火 保留.md"), "utf8").catch(() => ""))
    .toContain("客户端编辑");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await toSource();
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
  // A deleted document stays deleted; the storyboard draft can be saved elsewhere.
  await toBoard();
  await firstCard()
    .getByLabel("镜头标题", { exact: true })
    .fill("保留被删除文档的编辑");
  await rm(join(root, "01 灯火 保留.md"));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".conflict")).toBeVisible();
  await assert.rejects(access(join(root, "01 灯火 保留.md")));
  await page
    .locator(".conflict")
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  await page.getByLabel("文档文件名").fill("02 恢复草稿.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect
    .poll(() => readFile(join(root, "02 恢复草稿.md"), "utf8").catch(() => ""))
    .toContain("保留被删除文档的编辑");
  // Read-only originals permit draft edits and save-as, never an overwrite.
  await chmod(join(root, "02 恢复草稿.md"), 0o444);
  await page.getByRole("button", { name: "▤ 剧本大纲.md", exact: true }).click();
  await page
    .getByRole("button", { name: "▤ 02 恢复草稿.md", exact: true })
    .click();
  await firstCard()
    .getByLabel("镜头标题", { exact: true })
    .fill("只读副本标题");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "另存为", exact: true }).click();
  await page.getByLabel("文档文件名").fill("03 只读副本.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect
    .poll(() => readFile(join(root, "03 只读副本.md"), "utf8").catch(() => ""))
    .toContain("只读副本标题");
  assert.ok(
    !(await readFile(join(root, "02 恢复草稿.md"), "utf8")).includes(
      "只读副本标题",
    ),
  );
  await chmod(join(root, "02 恢复草稿.md"), 0o666);
  await firstCard()
    .getByLabel("镜头标题", { exact: true })
    .fill("未保存的新标题");
  await page.getByRole("button", { name: "返回项目首页", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.getByText("从文字，到每一个镜头。")).toBeVisible();
  await page.locator(".start-card", { hasText: "打开项目目录" }).click();
  await page.getByLabel("目录路径", { exact: false }).fill(testRoot);
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择要打开的作品" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "01 原创 渡口", exact: false })
    .click();
  await expect(editor).not.toBeVisible();
  await toSource();
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
    "PASS: external document creation, hidden structural actions, source structure edits, field edits, source synchronization, Ctrl+S, media, conflict/save-as, refresh, parent candidates and unsaved navigation/close.",
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
