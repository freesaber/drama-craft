/** Versioned on-disk contract. The UI consumes EpisodeData, not these headings. */
export const EPISODE_MARKER = "<!-- drama-craft:episode:v1 -->";
export const ROLE_COLUMNS = [
  "角色ID",
  "名称",
  "角色图",
  "音色文件",
  "使用镜号",
];
export const ASSET_COLUMNS = ["素材ID", "名称", "类型", "文件", "使用镜号"];
export const DIALOGUE_COLUMNS = [
  "镜号",
  "角色ID",
  "发声方式",
  "台词",
  "发声区间",
];
export const VIDEO_REF_COLUMNS = ["API参数", "提示词标签", "上传素材"];
const table = (columns: string[]) =>
  `| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|`;

export function createEpisodeTemplate(
  title: string,
  number: string,
  defaultResolution = "480p横(864*480)",
) {
  return `${EPISODE_MARKER}\n\n# 第${number}集 ${title.replace(/^\d+\s*/, "")}\n\n本集内容：\n\n## 角色绑定\n\n${table(ROLE_COLUMNS)}\n\n## 本集使用素材\n\n${table(ASSET_COLUMNS)}\n\n## 本集声音安排\n\n${table(DIALOGUE_COLUMNS)}\n\n## S001 镜头名\n\n角色：—\n\n### 故事走向\n\n### 首帧生成\n\n出图文件名：\`${number} 首帧_S001.png\`。\n\n**首帧图片提示词**\n\n\`\`\`text\n16:9横向单幅画面。场景与正式角色沿用对应参考图；跨镜群像沿用群像素材图。\n构图描述（景别、站位）。相邻镜可远景承接上一镜人物。只画动作开始前的静态一刻，不写心理说明。\n\`\`\`\n\n### 视频生成\n\n视频文件名：\`${number} S001.mp4\`。\n\n| API参数 | 提示词标签 | 上传素材 |\n|---|---|---|\n| \`ref_image_0\` | \`<Picture 1>\` | \`${number} 首帧_S001.png\` |\n\n**视频提示词｜duration=5，resolution=${defaultResolution}**\n\n\`\`\`text\n<Picture 1>：本镜完整首帧。\n在此描述可拍摄的动作、摄影机行为与声音；不要写小说式说明。\n\`\`\`\n`;
}

export function dialogueCharacterName(
  characterId: string,
  characters: { id: string; name: string }[],
): string {
  return characters.find((item) => item.id === characterId)?.name.trim() || characterId;
}

/** Dialogue-column lines in table order, including blank or placeholder cells. */
export function formatDialogueColumn(dialogues: { text: string }[]): string {
  return dialogues.map((line) => line.text).join("\n");
}

/** Plain lines for CapCut-style subtitle matching: `角色名：台词`. */
export function formatDialogueScript(
  dialogues: { characterId: string; text: string }[],
  characters: { id: string; name: string }[],
): string {
  return dialogues
    .map((line) => {
      const text = line.text.trim();
      if (!text || text === "—" || text === "-") return "";
      return `${dialogueCharacterName(line.characterId, characters)}：${text}`;
    })
    .filter(Boolean)
    .join("\n");
}
