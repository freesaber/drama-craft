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
      generationConfigured={false}
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
});
