/** Versioned on-disk contract. The UI consumes EpisodeData, not these headings. */
export const EPISODE_MARKER = "<!-- drama-craft:episode:v1 -->";
export const ROLE_COLUMNS = [
  "角色ID",
  "名称",
  "角色图",
  "音色文件",
  "音色状态",
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
const table = (columns: string[]) =>
  `| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|`;

export function createEpisodeTemplate(title: string, number: string) {
  return `${EPISODE_MARKER}\n\n# 第${number}集 ${title.replace(/^\d+\s*/, "")}\n\n本集内容：\n\n## 角色绑定\n\n${table(ROLE_COLUMNS)}\n\n## 本集使用素材\n\n${table(ASSET_COLUMNS)}\n\n## 本集声音安排\n\n${table(DIALOGUE_COLUMNS)}\n\n## S001 镜头名\n\n角色：—\n\n### 故事走向\n\n### 首帧生成\n\n出图文件名：\`${number} 首帧_S001.png\`。\n\n**首帧图片提示词**\n\n\`\`\`text\n在此描述动作开始前的静态画面。\n\`\`\`\n\n### 视频生成\n\n视频文件名：\`${number} S001.mp4\`。\n\n| API参数 | 提示词标签 | 上传素材 |\n|---|---|---|\n| \`ref_image_0\` | \`<Picture 1>\` | \`${number} 首帧_S001.png\` |\n\n**视频提示词｜duration=5，resolution=768p横**\n\n\`\`\`text\n<Picture 1>：本镜完整首帧。\n在此描述动作、摄影机行为与声音。\n\`\`\`\n`;
}
