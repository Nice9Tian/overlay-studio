# Overlay Studio 桌面壳构建指南

## 这个壳是什么？

本桌面壳用于将 `motion-playground`（Vite + React 的本地编辑台，后端即 Vite dev server 自身）连同 **Node、Chrome for Testing、ffmpeg** 一并打包成一个 Windows NSIS 安装包。

终端用户双击安装、双击打开后，即可获得一个独立的 WebView2 窗口。用户不需要自行安装 Node，不需要使用命令行，也不需要手动开启浏览器。该壳体仅支持 Windows x64，且未签名。

**为什么必须捆绑完整的 Node 和后端？**
因为 `vite.config.ts` 使用 `configureServer` 挂载了 `/api/media`、`/api/export`、`/api/export-status` 等 5 个必要的中间件，并没有 `configurePreviewServer` 钩子。这意味着 `vite build` 产出的静态文件无法包含这些后端功能。运行时必须起一个真实的 Vite dev server，壳的作用正是启动它、等待它就绪、把窗口导航过去，并在软件退出时连同衍生的 Chrome 一起杀干净。

## 构建环境清单

准备好以下工具链，刚装完 Node、Rust 或 ffmpeg 时**请务必关掉终端重新打开**，否则 PATH 会读不到。

| 组件 | 本机验证版本 | 验证命令 | 说明与安装法 |
|---|---|---|---|
| **Node.js** | `>= 22` (验证: `v24.19.0`) | `node -v` | 引擎要求 node >= 22.12.0。 |
| **Rust** | `stable` (验证: `rustc/cargo 1.98.1`) | `rustc --version` | 必须是 msvc 工具链，不能是 gnu。装法: [rustup.rs](https://rustup.rs/) |
| **Visual Studio Build Tools** | - | - | 安装时必须勾选「使用 C++ 的桌面开发」工作负载（Tauri 在 Windows 靠 MSVC 链接器）。 |
| **WebView2 Runtime** | - | - | Win10/11 基本自带；构建机上有 Edge 就有。 |
| **ffmpeg + ffprobe** | `9.0.1` (验证: `Gyan.dev full build 9.0.1`) | `ffmpeg -version` 和 `ffprobe -version` | 必须在 PATH 上。装法: `winget install --id Gyan.FFmpeg -e` |
| **Tauri CLI** | `2.11.4` | - | 已在 `desktop/package.json` 的 devDependencies 中，`npm install` 后 `npx tauri` 可用，不用全局装。 |

## 构建步骤

在 `desktop` 目录下顺序执行以下三条命令：

```powershell
cd desktop
npm install
npm run prepare-runtime
npm run build
```

1. `npm install`：安装 Tauri CLI 等必要的前端依赖。
2. `npm run prepare-runtime`：组装 `runtime/` 和 sidecar。
   - 抄一份 `node.exe` 当 sidecar。
   - 把 `motion-playground` 复制进 `runtime/app` 再 `npm ci`。
   - 把 puppeteer 钉死的 Chrome for Testing 150.0.7871.24 装进 `runtime/chrome`。首次要下 Chrome，解开约 420MB。
   - 把 `ffmpeg.exe` / `ffprobe.exe` 连同它的 LICENSE / README 抄进 `runtime/ffmpeg`。
   - 写入 `VERSIONS.json`。
   - *提示：该脚本是幂等的，支持 `--check` 只校验不复制。*
3. `npm run build`：执行 Tauri 构建打包。首次 cargo 编译要 5-15 分钟。

**产物位置**：`desktop\src-tauri\target\release\bundle\nsis\` 下的 `.exe` 安装包。

## 开发期怎么跑

开发期如果每次运行 `tauri dev` 都复制 800MB 的 runtime 会非常慢，所以可以通过设置环境变量 `OVERLAY_RUNTIME_DIR` 让壳直接使用现成的 runtime 目录。

```powershell
$env:OVERLAY_RUNTIME_DIR = '%USERPROFILE%\Documents\overlay-studio\desktop\src-tauri\runtime'
npm run dev
```

该变量只在开发期使用，装出来的包不需要它（包里使用 `resource_dir`）。

## 升级上游 motion-playground 时要注意什么

上游更新后，为了保证壳正常运行，请务必注意以下几点：

1. **必须重跑组装脚本**：`runtime/app` 只是复制品，上游改完必须重跑 `npm run prepare-runtime`，否则壳里跑的永远是旧代码。
2. **重新合入被修改的五处代码**：本项目对上游修改过五个文件，上游更新后要记得把改动合上去：
   - `motion-playground/package.json`：末尾有一段 `allowScripts`，放行 `esbuild` 和 `puppeteer` 的安装脚本。**漏合后果**：新版 npm 会拦安装脚本但 `npm ci` 仍返回 0，esbuild.exe 不落地，壳里的 Vite 到运行时才报错。
   - `motion-playground/vite.config.ts`：`overlayExport` 插件里 `spawn('node', ...)` 要改成 `spawn(process.execPath, ...)`；`reviewLog` 插件写 `exports/review-logs` 的路径要改成优先读环境变量 `OVERLAY_EXPORT_DIR`。**漏合后果**：sidecar 里 spawn 裸 node 会找不到（包里没装 Node）。
   - `motion-playground/scripts/export-frames.mjs`：增加 `EXPORT_ROOT`（有 `OVERLAY_EXPORT_DIR` 就用它，否则还是原版的 `ROOT/exports`），所有的 `outDir`、`finalDir` 以及磁盘空间预检（`freeBytes(EXPORT_ROOT)`）都要基于它。**漏合后果**：导出文件会写进安装目录，卸载时成品会被一起删掉。
     同一个文件的 puppeteer 启动参数里还多了一行 `--window-position=-32000,-32000`。**漏合后果**：导出时桌面左上角会挂着一个 780×580 的空黑窗口（Chrome 新无头模式在 Windows 11 上的已知问题），导完才消失。
     这个文件还有两块较大的改动要一并合入：**静态模式**（`staticDir` / `OVERLAY_EXPORT_STATIC_DIR`，用请求拦截把 `overlay.local` 映射到 `dist` 和 `public` 上的文件，并用 `pipe: true` 让 CDP 走管道）和**并行导出**（`workers` / `OVERLAY_EXPORT_WORKERS`，多开浏览器分段渲染，`auto` 时自动缩放）。**漏合后果**：桌面版的导出退回到需要 5177 端口、且单进程串行 —— 导出期间和编辑台抢 Vite，多核机器上慢好几倍。
   - `motion-playground/src/effects/useAnimation.ts`：`useEnter` 在导出模式下改按导出时钟决定进场（照同文件 `useCountUp` 的做法）。**漏合后果**：同一份编排每次导出都有约百帧随机差一帧，逐帧比对永远过不了；这是上游原有的 bug，预览不受影响。
   - `motion-playground/src/ExportView.tsx`：`__setExportT` 用 `flushSync` 同步提交这一帧的挂载。**漏合后果**：卡片出现的那一帧时有时无，导出不可复现。
3. **兼容性说明**：这五处改动在没有环境变量、不在导出模式时行为和原版完全一致，命令行用户零感知。
4. **不要动静态目录**：`public/_fxframes`、`public/sfx` 这些路径不要动，dev server 要 serve 它们。

## 给最终用户：首次运行

**安全提示**
装的时候 Windows 可能会弹「Windows 已保护你的电脑」。这是因为开发者没买代码签名证书，点「更多信息」→「仍要运行」即可。这是正常的，不是病毒。

**安装权限与位置**
软件会装到你的当前用户目录（`%LOCALAPPDATA%`），**不需要管理员权限**。公司电脑没管理员账号也能装。

**去哪里找导出的视频？**
导出的成品保存在「视频\Overlay Studio\output」（完整路径 `%USERPROFILE%\Videos\Overlay Studio\output`）。
菜单 **文件** → **打开导出成品文件夹** 可以直接打开。成品不放在安装目录，所以卸载软件不会删掉它们。

**字体怎么装？**
包里不带中文字体（授权原因，和命令行版一致）。
点击菜单 **文件** → **打开字体文件夹**，把你准备好的字体丢进去即可。

**报错「端口 5177 被占了」怎么办？**
壳会弹对话框说端口被别的程序占用。如果占用它的就是命令行版的 Overlay Studio，壳会直接连上去用，不会报错。
如果要查是谁占的：打开 PowerShell，执行 `netstat -ano | findstr :5177` 拿到末尾的 PID，再执行 `tasklist /FI "PID eq 那个PID"` 看是什么程序，关掉它再重新启动。

**出问题看日志**
点击菜单 **帮助** → **查看运行日志**，里面有个 `sidecar.log`，记录了具体的运行报错信息。
