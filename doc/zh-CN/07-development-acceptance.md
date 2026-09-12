# 07 开发指南与验收

[English](../en/07-development-acceptance.md) · [目录](../README.md)

## 环境与运行

Windows 10/11、Node.js 22、npm、Rust stable 的 MSVC 工具链、Visual Studio C++ 桌面开发组件和 WebView2。参考 [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)。开发默认端口 1420，若被占用明确退出，不自动换端口。

```powershell
npm ci
npm run tauri dev
```

`npm run dev` 只展示浏览器界面，不提供本地文件功能。`npm run tauri build -- --no-bundle` 输出 `src-tauri/target/release/drama-craft.exe`；不带 `--no-bundle` 时打包 NSIS。图标由原创几何图形脚本生成，不依赖私人素材。

## 自动检查

```powershell
npm run check
npm test
npm run build
npm run docs:check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Markdown 测试覆盖真正标题与代码块的区别、重复镜号、表格/行内代码/引用式链接素材、中文绝对路径、远程素材排除及自然排序。Rust 临时目录测试覆盖 BOM/CRLF 保存、外部冲突、删除后保存、路径越界、Windows 名称、只读属性、移动后项目标识、损坏元数据、素材缺失和非 UTF-8。

## 真实目录只读检查

设置 `DRAMACRAFT_COMPAT_DIR` 为本机作品目录，然后运行忽略的兼容测试：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml external_workspace_readonly_check -- --ignored
```

该检查直接使用只读扫描/读取，不调用项目初始化，并对比所有文件的前后哈希。预期样本为 12 集；分镜识别的目标为 184 镜，首集 13 镜。真实路径不写入仓库，素材与文稿不复制为公开测试样例。

## 桌面交互验收

在临时原创项目中检查创建、最近项目重开、新建分集、Ctrl+S、分镜跳转、素材面板、外部改动冲突、另存为与退出保护。原目录保存测试一律不在真实作品上执行。界面检查覆盖默认窗口与最小窗口，素材解码失败仍可系统打开。

## 交付边界

P0 无自动保存、后台监听、数据库、付费请求、素材归集、完整备份或视频导出。预览受系统编解码能力限制，混合换行保存会规范化，原子替换不等于跨进程 compare-and-swap。人工正在编辑的内容不会在自动刷新时被覆盖。

准备公开发布时再选择许可证、审核依赖分发许可与安装包签名。更新功能时同步两种语言文档；不要把编译成功写成尚未执行的 UI 或云端验收通过。
