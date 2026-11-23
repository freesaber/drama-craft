import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BoardView from "./BoardView";
import { parseStoryboard } from "./storyboard";
import { optionsFromProfile } from "./videoWorkflows";
import type { Project } from "./types";

const project: Project = {
  handle: "test-project",
  root: "",
  metadata: {
    id: "test-project",
    name: "示例项目",
    formatVersion: 1,
    layout: "preserve",
    libraries: { voices: "" },
  },
  warning: null,
};

function renderDocument(document: string) {
  return renderToStaticMarkup(
    <BoardView
      board={parseStoryboard(
        "# 创作说明\n\n示例文件：`0001 素材_王宫大殿.png`。\n",
      )}
      project={project}
      document={document}
      documents={[]}
      refreshKey={0}
      busy={false}
      apply={() => false}
      savePatch={async () => {}}
      readonly={false}
      source={() => {}}
      active={0}
      select={() => {}}
      defaultVideoApiProfileId=""
      videoApiProfiles={[]}
      videoWorkflow={optionsFromProfile(undefined)}
      configureGeneration={() => {}}
      useVideo={async () => {}}
    />,
  );
}

describe("document asset references", () => {
  it.each(["AGENTS.md", "资料/AGENTS.md", "资料\\agents.MD"])(
    "omits the asset panel for %s while retaining its content and source action",
    (document) => {
      const html = renderDocument(document);
      expect(html).toContain("创作说明");
      expect(html).toContain("0001 素材_王宫大殿.png");
      expect(html).toContain("<button>定位源码</button>");
      expect(html).not.toContain("<summary>素材引用</summary>");
    },
  );

  it("retains asset references for other documents", () => {
    expect(renderDocument("创作笔记.md")).toContain(
      "<summary>素材引用</summary>",
    );
  });

  it("renders the temporary materials tab with count for episode shots", () => {
    const episodeSource = [
      "<!-- drama-craft:episode:v1 -->",
      "",
      "# 第0001集 渡口灯火",
      "",
      "本集内容：测试临时素材标签。",
      "",
      "## 角色绑定",
      "",
      "| 角色ID | 名称 | 角色图 | 音色文件 |",
      "|---|---|---|---|",
      "| C0001 | 旅人 | `0001 素材_旅人.png` | `F:/voices/a.mp3` |",
      "",
      "## 本集使用素材",
      "",
      "| 素材ID | 名称 | 类型 | 文件 |",
      "|---|---|---|---|",
      "",
      "## 本集声音安排",
      "",
      "| 镜号 | 角色ID | 角色名称 | 台词 |",
      "|---|---|---|---|",
      "",
      "## S0001 点灯",
      "",
      "角色：C0001",
      "",
      "### 故事走向",
      "",
      "旅人站在岸边。",
      "",
      "### 首帧生成",
      "",
      "出图文件名：`0001 首帧_S0001.png`。",
      "",
      "GPT附件：**图片1＝渡口（`0001 素材_渡口.png`）**。",
      "",
      "临时素材：**临时1＝新机位空景（`0001 临时_S0001_01.png`）；临时2＝人物合成（`0001 临时_S0001_02.png`）**。",
      "",
      "**首帧图片提示词**",
      "",
      "```text",
      "步骤1：先出空景。",
      "```",
      "",
      "### 视频生成",
      "",
      "视频文件名：`0001 S0001.mp4`。",
      "",
      "| API参数 | 提示词标签 | 上传素材 |",
      "|---|---|---|",
      "| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0001.png` |",
      "",
      "**视频提示词｜duration=5，resolution=768p横**",
      "",
      "```text",
      "<Picture 1> is the first frame of [Shot 1].",
      "```",
      "",
    ].join("\n");
    const html = renderToStaticMarkup(
      <BoardView
        board={parseStoryboard(episodeSource)}
        project={project}
        document="0001 渡口灯火.md"
        documents={[]}
        refreshKey={0}
        busy={false}
        apply={() => false}
        savePatch={async () => {}}
        readonly={false}
        source={() => {}}
        active={0}
        select={() => {}}
        defaultVideoApiProfileId=""
        videoApiProfiles={[]}
        videoWorkflow={optionsFromProfile(undefined)}
        configureGeneration={() => {}}
        useVideo={async () => {}}
      />,
    );
    expect(html).toContain("临时素材<span>2</span>");
  });
});
