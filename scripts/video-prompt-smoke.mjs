// Isolated browser checks; no project files or application preferences are used.
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0, strictPort: false } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  await page.evaluate(async () => {
    const { default: React } =
      await import("/node_modules/.vite/deps/react.js");
    const {
      default: { createRoot },
    } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { default: Editor } = await import("/src/VideoPromptEditor.tsx");
    document.querySelector("#root").style.display = "none";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    window.promptTest = {
      value: "原始提示词",
      calls: [],
      fail: false,
      disabled: false,
    };
    window.renderPrompt = () =>
      root.render(
        React.createElement(Editor, {
          value: window.promptTest.value,
          disabled: window.promptTest.disabled,
          save: async (value) => {
            window.promptTest.calls.push(value);
            if (window.promptTest.fail) throw new Error("模拟保存冲突");
            await new Promise((resolve) => {
              window.finishPromptSave = resolve;
            });
            window.promptTest.value = value;
            window.renderPrompt();
          },
        }),
      );
    window.renderPrompt();
  });
  const editor = page.getByRole("textbox", { name: "视频提示词", exact: true });
  const undo = page.getByRole("button", { name: "撤销", exact: true });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await expect(editor).toHaveValue("原始提示词");
  await expect(undo).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "复制", exact: true }),
  ).toHaveCount(0);
  await editor.fill("修改内容\n第二行");
  await expect(save).toBeEnabled();
  expect(await page.evaluate(() => window.promptTest.value)).toBe("原始提示词");
  await undo.click();
  await expect(editor).toHaveValue("原始提示词");
  await expect(save).toBeDisabled();
  await editor.fill("原始提示词");
  await expect(undo).toBeDisabled();
  await editor.fill("修改内容\n第二行");
  await save.click();
  await expect(editor).toBeDisabled();
  await expect(undo).toBeDisabled();
  await page.evaluate(() => window.finishPromptSave());
  await expect(editor).toBeEnabled();
  await expect(editor).toHaveValue("修改内容\n第二行");
  await expect(save).toBeDisabled();
  await page.evaluate(() => {
    window.promptTest.fail = true;
  });
  await editor.fill("失败后保留");
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("模拟保存冲突");
  await expect(editor).toHaveValue("失败后保留");
  await expect(save).toBeEnabled();
  await page.evaluate(() => {
    window.promptTest.value = "外部新内容";
    window.renderPrompt();
  });
  await save.click();
  await expect(page.getByRole("alert")).toContainText("文档草稿已改变");
  expect(await page.evaluate(() => window.promptTest.calls.length)).toBe(2);
  await undo.click();
  await expect(editor).toHaveValue("外部新内容");
  await expect(save).toBeDisabled();
  await page.evaluate(() => {
    window.promptTest.disabled = true;
    window.renderPrompt();
  });
  await expect(editor).toBeDisabled();
  console.log(
    "Video prompt browser checks passed: draft, undo, save, failure, stale source, readonly.",
  );
} finally {
  await browser?.close();
  await server.close();
}
