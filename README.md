# DramaCraft · 剧匠

[English](README.en.md) · [开发文档](doc/README.md)

基于 Tauri 的本地短剧工作台。剧本、提示词与素材保存在自己的项目文件夹中，可以继续使用外部编辑器编辑 Markdown，无需部署后端。

## 当前版本：P0 文本工作台

- 创建项目时指定工作目录，或直接打开已有目录；保留原文件名及素材布局。
- 编辑、预览和显式保存 Markdown；按分集文件与 `## S001 镜头名` 标题导航。
- 识别素材链接和行内代码中的文件名，检查本地文件，预览图片、音频和视频。
- 外部文件改动检测、保存冲突保护、另存为、未保存退出提示。
- Markdown 为正文原件，JSON 保存项目元数据；P0 不使用 SQLite。

**尚未实现：** 大模型生成、H3 视频调用、全局角色与声音库、FFmpeg 拼接、自动备份与项目打包。接口能力和后续阶段见 [路线图](doc/zh-CN/05-roadmap.md)。

## 开发运行

需要 Node.js 22、npm、Rust stable MSVC、Visual Studio C++ 桌面开发工具和 WebView2。详见 [开发指南](doc/zh-CN/07-development-acceptance.md)。

```powershell
npm ci
npm run tauri dev
```

仅预览前端：`npm run dev`。浏览器模式不能访问本地项目；本地功能需要 Tauri 桌面客户端。

```powershell
npm test
npm run build
npm run docs:check
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

最后一条命令生成 Windows 可执行文件；`npm run tauri build` 生成 NSIS 安装包。依赖锁文件纳入版本管理。

## 使用方式

1. 点击“创建项目”，选择父目录并输入项目名称；客户端创建同名文件夹和初始大纲、分镜总表。
2. 或点击“打开项目目录”，选择具体作品文件夹；选到上级目录时可以选择候选作品。
3. 编辑后按 `Ctrl+S` 保存。外部编辑器修改后，回到窗口或点击“刷新”重新检查。
4. 冲突时原编辑内容保留，可以另存为新文档，或确认放弃编辑后读取磁盘版本。

仅支持 UTF-8 Markdown（可带 BOM）；新文件用 LF，已有 CRLF 文档保留 CRLF。素材文件可以与文档混放，或位于子目录。现有绝对路径保持原样，迁移到另一台电脑后需要自行重新定位外部素材。

## 开源准备

工程与中英文文档已建立，许可证待正式开源前确定，尚未授予开源许可。仓库不包含私人剧本、音色、角色图或生成视频，测试使用原创精简样例。后续发布不默认授权第三方或私人素材。
