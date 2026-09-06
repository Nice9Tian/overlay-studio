# Overlay Studio 桌面壳(Tauri v2)· 设计契约

所有参与构建的人/Agent 以本文件为准。改契约先改这里,再改代码。

## 目标

把 `motion-playground`(Vite + React 的本地编辑台,后端就是 Vite dev server 自己)连同
**Node、Chrome for Testing、ffmpeg** 一起打成一个 Windows NSIS 安装包。用户双击安装、
双击图标,得到一个**独立窗口**(WebView2),不需要装 Node、不需要命令行、不需要浏览器。

只做 Windows x64。没有代码签名证书(首次运行会有 SmartScreen 提示,文档里说明怎么点)。

## 为什么是这个形状(已核实的事实)

- 后端不可拆:`motion-playground/vite.config.ts` 用 `configureServer` 挂了 5 个中间件
  (`/api/media` `/api/export` `/api/export-status` `/api/review-log` `/api/upload-demo`)。
  没有 `configurePreviewServer`,`vite build` 出来的静态文件没有后端。所以**运行时必须跑 Vite dev server**,
  这也保住了字体热识别(`src/fonts.ts` 用 `import.meta.glob` 扫 `src/assets/fonts/`)。
- 导出必须用 puppeteer 钉死的 Chrome for Testing **150.0.7871.24**(`node_modules/puppeteer-core/lib/puppeteer/revisions.js`)。
  `scripts/export-frames.mjs` 明确禁止回退到系统 Chrome(作者实测 Chrome 151 无头+虚拟时间下 CSS 动画不推进,会出坏片)。
  puppeteer 通过环境变量 `PUPPETEER_CACHE_DIR` 找 Chrome。
- 合成靠 PATH 上的 `ffmpeg` 和 `ffprobe`(裸命令名 spawnSync)。
- Vite 配置 `server.open: true` 会自动开浏览器;设环境变量 `BROWSER=none` 可关掉(已在 vite 源码核实)。
- 端口固定 5177,`strictPort: true`,被占就退出。

## 目录约定

```
desktop/
  package.json                 已建。@tauri-apps/cli 2.11.4 已装(npx tauri 可用)
  DESIGN.md                    本文件
  README.md                    任务 D:构建步骤、首次运行说明、第三方许可说明
  scripts/prepare-runtime.mjs  任务 C:组装 runtime/ 和 sidecar
  ui/index.html                任务 B:启动等待页(纯静态,无框架)
  src-tauri/
    Cargo.toml  build.rs  tauri.conf.json  capabilities/default.json
    src/main.rs  src/lib.rs   任务 B
    icons/                     任务 D 生成(npx tauri icon)
    binaries/node-x86_64-pc-windows-msvc.exe     任务 C 生成(sidecar;不进 git)
    runtime/                   任务 C 生成(不进 git)
      app/                     motion-playground 的副本(含 node_modules)
      chrome/                  PUPPETEER_CACHE_DIR 的结构:chrome/win64-150.0.7871.24/chrome-win64/chrome.exe
      ffmpeg/                  ffmpeg.exe、ffprobe.exe,以及该构建自带的 LICENSE/README
      VERSIONS.json            {"node","chrome","ffmpeg","app","builtAt"}
```

`tauri.conf.json` 里:`bundle.externalBin: ["binaries/node"]`,`bundle.resources: { "runtime/": "runtime/" }`。
运行时 Rust 用 `app.path().resource_dir()` 拼出 `<resource_dir>/runtime/...`。
**开发期例外**:环境变量 `OVERLAY_RUNTIME_DIR` 存在时直接用它当 runtime 目录(免得 `tauri dev` 每次复制 800MB)。

## 运行时环境(Rust → node sidecar → 它的子进程全部继承)

| 项 | 值 |
|---|---|
| 可执行 | sidecar `node`(即 `binaries/node-x86_64-pc-windows-msvc.exe`) |
| 参数 | `<runtime>/app/node_modules/vite/bin/vite.js --port 5177 --strictPort --host 127.0.0.1` |
| cwd | `<runtime>/app` |
| `PATH` | `<runtime>/ffmpeg;<sidecar 所在目录>;` + 原 PATH |
| `PUPPETEER_CACHE_DIR` | `<runtime>/chrome` |
| `BROWSER` | `none` |
| `OVERLAY_EXPORT_DIR` | `%USERPROFILE%\Videos\Overlay Studio`(任务 A 让脚本认这个变量;目录不存在由脚本自己 mkdir) |
| `OVERLAY_EXPORT_STATIC_DIR` | `<runtime>/app/dist`(任务 F 的静态模式:导出页从这份构建产物读,Chrome 走请求拦截 + CDP 管道,不占端口;dist 由 prepare-runtime.mjs 构建并断言)。**`dist/index.html` 不存在时这一行不写**:脚本对该变量是硬失败(缺 index.html 直接退 1),老 runtime / 开发期 `OVERLAY_RUNTIME_DIR` 指到未构建的目录时,不设它才能退回服务器模式出片 |
| `OVERLAY_EXPORT_WORKERS` | `auto`(任务 G 的并行导出:按 CPU/内存上限和实测帧耗时自动决定开几个浏览器,帧数少或只能开 1 个时退回单进程) |
| stdout/stderr | 追加写到 `<app_log_dir>/sidecar.log`(`app.path().app_log_dir()`,一般在 `%LOCALAPPDATA%\<identifier>\logs`) |

## 上游改动(任务 A,`motion-playground/`,越少越好,要能跟着作者更新)

1. `vite.config.ts` overlayExport 插件:`spawn('node', …)` → `spawn(process.execPath, …)`。
2. `scripts/export-frames.mjs`:新增 `const EXPORT_ROOT = process.env.OVERLAY_EXPORT_DIR ? path.resolve(process.env.OVERLAY_EXPORT_DIR) : path.join(ROOT, "exports")`。
   `outDir`、`finalDir` 改基于 `EXPORT_ROOT`;磁盘空间预检 `freeBytes(ROOT)` 改成 `freeBytes(EXPORT_ROOT)`(先 mkdir 再查,否则 statfs 报错走 Infinity)。
   `public/_fxframes`、`public/sfx` 等**不动**,它们是 dev server 要能 serve 的路径。
3. `vite.config.ts` reviewLog 插件:`exports/review-logs` 同样改成 `OVERLAY_EXPORT_DIR` 优先。
3a. `scripts/export-frames.mjs` 的 puppeteer 启动参数加 `--window-position=-32000,-32000`。
   Chrome 的新无头模式(`--headless=new`)在 Windows 11 上会把一个 780×580 的空窗口画到桌面左上角
   (Chrome 129 起的已知问题,puppeteer #13145 / selenium #14550),导出全程挂着。2026-09-06 实测:
   直接用包里的 chrome.exe 跑 `--headless=new about:blank` 就能复现,和壳无关;加了这个参数后窗口在屏幕外,
   桌面像素干净。渲染走离屏缓冲,不受影响。命令行版同样受益。
4. 不改 UI、不改端口、不改 `open: true`(靠 BROWSER=none 关)。
5. 没有环境变量时行为和改动前**完全一致**(命令行用户零感知)。
6. `motion-playground/package.json` 需要 allowScripts 块放行 esbuild 和 puppeteer 的安装脚本,否则 npm ci 时 npm 会拦安装脚本、esbuild 的 postinstall 不跑、esbuild.exe 不落地,而且 npm ci 仍然返回 0,故障要到运行时才暴露。

## Rust 行为(任务 B,`desktop/src-tauri/`)

启动顺序:

1. **单实例**:`tauri-plugin-single-instance`,第二次启动只把已有窗口置前。
2. **端口检查**:尝试连接 `127.0.0.1:5177`。能连上 → GET `/`,响应体含 `Overlay Studio` 就当作已有实例(比如用户命令行自己起的),跳过 sidecar 直接开窗;不含 → 原生对话框「端口 5177 被别的程序占用,关掉它再启动」,退出。
3. **起 sidecar**:按上表环境启动;日志落盘。
4. **等待页**:立刻显示窗口,内容是 `ui/index.html`(「正在启动 Overlay Studio…」+ 转圈,纯静态)。
5. **就绪切换**:每 250ms 轮询 TCP `127.0.0.1:5177`,可连后**再等到 GET `/` 返回 200**,然后把窗口导航到 `http://127.0.0.1:5177/`。
   写 127.0.0.1 不写 localhost:sidecar 只监听 IPv4;localhost 在 WebView2 里可能先解析成 `::1`,本机若有别的程序恰好监听 `[::1]:5177`(开发期另起的 vite 就会),窗口会连到错的服务上。
   90 秒超时 → 等待页显示失败原因和日志文件路径(用 `eval` 注入一段文本即可,不需要 IPC)。
6. **窗口**:标题 `Overlay Studio`,初始 1600×960,最小 1200×720,居中,可最大化。记住上次尺寸(`tauri-plugin-window-state`)。
7. **菜单栏**(原生,`tauri::menu`):
   - 文件:打开导出成品文件夹(`OVERLAY_EXPORT_DIR/output`)| 打开字体文件夹(`<runtime>/app/src/assets/fonts`)| 打开素材文件夹(`<runtime>/app/public/_media`)| 分隔 | 退出
   - 帮助:查看运行日志(打开 `<app_log_dir>`)| 关于(对话框:壳版本 + `VERSIONS.json` 里的 node/chrome/ffmpeg/app 版本)
   - 打开文件夹一律先 `create_dir_all` 再 `explorer.exe <path>`。
8. **退出**:窗口关闭或 `RunEvent::ExitRequested/Exit` → `taskkill /F /T /PID <sidecar pid>`(必须 `/T`:导出时 node 下面还挂着 Chrome)。
9. **外链**:导航到非 `localhost`/`127.0.0.1` 的 http(s) 地址时,拦下来用系统浏览器打开(`on_navigation` 返回 false + `tauri-plugin-opener`)。`_blank` 链接同样处理。
10. 窗口加载的是远程地址 `http://127.0.0.1:5177/`,**不需要 Tauri IPC**;`app.security.csp` 设 `null`。等待页是本地静态页,同样不需要 IPC。
11. **不装 `tauri-plugin-dialog`。** 它会往每个页面注入脚本,把 `window.alert` / `window.confirm` 换成走 IPC 的异步版本:
    编辑台是远程地址,IPC 被 ACL 拒掉,页面里所有 alert 静默消失(2026-09-06 实测,日志里一串
    `plugin:dialog|message not allowed by ACL`);就算放行,confirm 变异步后 `if (!confirm(...)) return` 这种同步守卫
    永远不拦,「清空编排」会不经确认直接执行。WebView2 自带的同步 alert / confirm 本来就能用,Rust 侧的几个
    原生提示框(端口被占、Node 起不来、关于)直接用 `rfd`。

crate 建议:`tauri = "2"`(features `["devtools"]` 可选)、`tauri-build = "2"`、`tauri-plugin-shell = "2"`、
`tauri-plugin-single-instance = "2"`、`tauri-plugin-opener = "2"`、`tauri-plugin-window-state = "2"`、`rfd = "0.16"`。

## 安装包(`tauri.conf.json`)

- `productName: "Overlay Studio"`,`identifier: "com.overlaystudio.desktop"`,`version` 跟 `desktop/package.json`。
- `bundle.targets: ["nsis"]`,`bundle.windows.nsis.installMode: "currentUser"`(装到 `%LOCALAPPDATA%`,不要管理员,目录可写),
  `languages: ["SimpChinese", "English"]`,`displayLanguageSelector: false`。
  (NSIS 的简体中文语言文件就叫 `SimpChinese.nlf`,没有 `SimplifiedChinese` 这个名字;
  写错了配置阶段不报错,一直要到 makensis 才以 `Can't open language file` 失败。)
- `bundle.windows.webviewInstallMode`:默认 `downloadBootstrapper`(Win10/11 基本都自带 WebView2)。
- 开始菜单 + 桌面快捷方式(NSIS 默认)。
- `frontendDist: "../ui"`(等待页所在目录),`devUrl` 不设(不走 Vite 的 Tauri 集成)。
- 图标:`src-tauri/icons/`(任务 D 用 `npx tauri icon <源图>` 生成,源图用 `motion-playground/public/favicon.svg`;太糊就先渲染成 1024px PNG)。

## 组装脚本(任务 C,`desktop/scripts/prepare-runtime.mjs`)

Node ≥ 22 的 ESM 脚本,幂等,`npm run prepare-runtime` 调用。步骤:

1. **sidecar**:复制 `process.execPath` → `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`。
2. **app**:清空 `runtime/app` 后复制 `../motion-playground`,排除 `node_modules` `exports` `dist` `public/_media` `public/_fxframes` `src/assets/fonts`(`README.md` 除外) `public/sfx`(`README.md` 除外) `public/logos`(`*.png` 除外) `public/demo`(`demo-overlay.json` / `demo.srt` / `README.txt` 除外) `.vite` `*.log` `*.mp4/*.mov/*.webm`。
   然后在 `runtime/app` 里跑 `npm ci`(环境变量 `PUPPETEER_SKIP_DOWNLOAD=1`,Chrome 单独处理;新版 npm 会拦安装脚本,需要 `npm approve-scripts esbuild puppeteer` 或等价手段,esbuild 的 postinstall 必须跑)。
3. **chrome**:版本号从 `runtime/app/node_modules/puppeteer-core/lib/puppeteer/revisions.js` 读。puppeteer-core 各版本目录布局不同,脚本按 lib/esm/puppeteer/ 到 lib/puppeteer/ 到 lib/cjs/puppeteer/ 顺序探测,取第一个存在的。
   优先从 `%USERPROFILE%\.cache\puppeteer\chrome\win64-<ver>` 复制到 `runtime/chrome/chrome/win64-<ver>`;
   没有就在 `runtime/app` 里跑 `npx puppeteer browsers install chrome@<ver> --path <runtime/chrome 绝对路径>`。
   **不带 `chrome-headless-shell`**(headless "new" 不用它)。结束时断言 `chrome.exe` 存在。
4. **ffmpeg**:在 PATH 或 winget 包目录(`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin`)找 `ffmpeg.exe` `ffprobe.exe`,
   连同该构建目录里的 `LICENSE*` `README*` 一起复制到 `runtime/ffmpeg/`。找不到就报错退出,并打印 `winget install --id Gyan.FFmpeg -e`。
5. **VERSIONS.json**:`node`(执行 sidecar 自己 `--version` 的输出,而不是跑脚本的那个 node)、`chrome`(上面的版本号)、`ffmpeg`(`ffmpeg -version` 首行)、`app`(motion-playground/package.json 的 version)、`appSrcHash`(按 shouldExclude 排除规则遍历 motion-playground 后,对每个文件的相对路径、size、mtimeMs 排序拼串做的 sha256)、`builtAt`(ISO 时间)。
6. `--check`:只校验各产物存在与版本一致,不复制。会重算 appSrcHash,不一致就报 runtime/app 落后于 motion-playground 并以退出码 1 退出。
7. 全程打印每一步在做什么和体积;失败要说清楚缺什么、怎么补。

## 集成验收(任务 E,在 A–D 之后)

1. `cd desktop && npm run prepare-runtime && npm run build`(首次 cargo 编译约 5–15 分钟)。
2. 运行 `src-tauri/target/release/overlay-studio.exe`(名字以 tauri.conf.json 为准):
   - 窗口出现,10 秒内切到编辑台;`curl http://127.0.0.1:5177/` 有 HTML;
   - 进程树里有 node 子进程;
   - `POST /api/export` 用 `runtime/app/public/demo/demo-overlay.json` 触发导出,轮询 `/api/export-status` 到 done,
     `%USERPROFILE%\Videos\Overlay Studio\output\` 里出现 `.mov`;
   - 关闭窗口后 `tasklist` 里没有残留 node.exe / chrome.exe(本次启动的那些)。
3. NSIS 安装包在 `src-tauri/target/release/bundle/nsis/`,装到临时用户目录跑一遍同样的检查,再卸载。
4. 结果写到 `desktop/BUILD-REPORT.md`:通过/失败项、体积、耗时、遗留问题。

## 不做的事

- 不改 motion-playground 的 UI;不签名;不做 macOS;不做自动更新。
- 不把导出产物放进安装目录(卸载会一起删)。
- 不把字体、音效打进包(授权原因,和上游一致)。

---

## 第二轮:导出去服务器化 + 并行导出 + 自动缩放(任务 F / G / H / V)

三件事都落在 `motion-playground/scripts/export-frames.mjs`(我们维护的上游改动之一)和 `desktop/` 里。
**红线:`workers=1` 且不设静态目录时,代码路径和改动前逐字节等价。**

并行/静态的一致性红线原来写的是「每一帧 PNG 哈希必须和串行、服务器模式完全一致」。
**2026-09-06 裁决:改成「噪声包络 + 边界零差异」判定。** 原因是这条字面要求在当前 `src/` 上不可达 ——
用未经本轮改动的 HEAD 原版脚本、同一台机器、同一份 demo 编排、服务器模式连跑两次,854 帧里就有
154 帧 sha256 不一致(静态模式串行重跑两次也有 9~113 帧)。根因在应用层不在导出脚本:
`src/effects/useAnimation.ts` 的 `useEnter` 用两层 `requestAnimationFrame` 翻 `entered`,
「哪一帧翻」取决于虚拟时间推进期间实际跑掉几次 rAF,于是**每张卡的进场窗口**都是不确定的
(计数/进度类钩子已经有 `useExportMs` 的确定性通路,不是噪声来源)。要按字面达成必须改 `src/`,
本轮明令不动它。

新判定(V 节的验收按这个执行):

1. **噪声包络**:同一配置至少重跑 2 次,取差异帧集合作为该配置的噪声。跨配置(静态×1、
   静态×N 对服务器×1)的差异帧数必须落在服务器×1 自身噪声的
   `max(1.5 倍, +10 帧)` 以内。
2. **边界零差异**(并行专用,不可放宽):对每个工作器的分段起点 `s_i`,盯窗口 `[s_i, s_i+40)`
   (40 帧宽于实测最长的进场过渡 30 帧)。判死的特征是**块的起点精确等于 `s_i`**:
   从 `s_i` 起连续 ≥5 帧与基线不一致,且同配置复跑在 `s_i` 这一帧是一致的。
   这一条是判定「并行有没有引入新偏差」的真正判据 —— 只看「差异帧是否落在噪声集里」会漏掉
   它,因为噪声集恰好覆盖了各卡进场区间,边界块正好藏在里面(2026-09-06 实测教训)。
   **2026-09-06 补第三条判据:`s_i` 本身落在本底噪声集里时不作数。**
   实测:自动缩放挑的 `工作器4@711` 正好落在 `stat-proof` 的分项进场窗口(696-742)内,
   `staticAuto` 对基线在 `[711,742]` 连续 32 帧不一致、同配置复跑又恰好在 711 一致,
   前两条判据全中;但**两次串行**(`static1` vs `static1b`,`workers=1`,根本没有分段)
   在同一区间同样整段 696-742 不一致,分段起点为 291/486/674 的 `static4` 亦然 ——
   这个块和并行无关,是 `useEnter` 在这张卡上的双稳态。所以再要求 `s_i` 不在
   「所有同配置复跑对」的差异帧并集里。这不是放宽:真正的快进 bug 其块起点落在噪声之外
   (上一轮实测噪声集 `{30,74,119,357-374,382-396,408-421}`,块在 268-297,零重叠),照样抓得住。
3. **严格逐帧**:另用一份**只留全程铺底、不做分项进场的卡**的子集编排(demo 里是
   `chapter-bar` + `caption-track`,`verify-export-modes.mjs --css-only` 自动摘)跑八种组合,
   **第 31 帧起**必须逐帧完全一致。开头 30 帧豁免:这两张卡也走 `useEnter`,只是都在 t=0 挂载,
   那一次两层 rAF 的抖动只影响开头一次进场过渡(实测 20 帧 ≈ 0.65s);实测同一份配置
   连跑两遍(static4 / static4b)也恰好在第 1-20 帧上分成两种状态,所以这一段与静态/并行无关。
   这一条证明导出脚本本身(重构、静态供给、并行分段)是确定的,把不确定性完全归因到应用层。
   **2026-09-06 实测结果:通过** —— 服务器×1 ×2、静态×1 ×2、静态×auto(选 5)×2、静态×4 ×2,
   854 帧里判的 824 帧全部逐帧 sha256 相同。
4. **带视频卡的编排**:必须单独验一次(快进里的 `__seekVideos` 和「整幅光栅化」都只有它能测到)。
   实测(`focus-card` + `camSrc`、345 帧):静态×1 ×2 与静态×3 ×2 四次跑 **345/345 逐帧相同**。

### F. 静态模式:Chrome 不再需要端口

已核实的事实:导出页 `?export=1` 由 `src/main.tsx` 切到 `ExportView`,它不调任何 `/api/`;`npx vite build` 1 秒出 `dist/`
(index.html + assets/ + public/ 的副本,4.4MB);puppeteer 25 在参数含 `--remote-debugging-pipe` 时走管道
(`node_modules/puppeteer-core/lib/puppeteer/node/BrowserLauncher.js` 第 74 行),`pipe: true` 就是加这个参数。

1. **触发**:job 字段 `staticDir`(dist 的绝对路径)或环境变量 `OVERLAY_EXPORT_STATIC_DIR`。没设 → 老的服务器模式,一行不变。
2. **启动**:静态模式 `LAUNCH_OPTS` 加 `pipe: true`(CDP 走管道,不占端口);`--window-position=-32000,-32000` 两种模式都保留。
3. **地址**:`http://overlay.local/index.html?export=1&mode=timeline&fx=<scale>&spd=<speed>`。这个主机名不存在,全部请求由拦截器接管。
4. **拦截**(`page.setRequestInterception(true)`,在 `goto` 之前):按 URL 路径映射到文件,`request.respond({status, contentType, body})`:
   - `/` 与 `/index.html` → `<staticDir>/index.html`
   - `/assets/*` → `<staticDir>/assets/*`
   - `/src/assets/fonts/*` → `<ROOT>/src/assets/fonts/*`(用户丢进去的字体,构建时可能还没有)
   - 其余路径 → 先找 `<ROOT>/public/<path>`(`_fxframes`、`_media`、`sfx`、`demo`、`logos` 都在这,运行期生成的也在这),再找 `<staticDir>/<path>`;都没有 → 404。
   - 主机不是 `overlay.local` 的请求 → `request.abort()`,只在第一次打一行日志。
   - MIME 按扩展名:html / js(`text/javascript`)/ css / json / png / jpg / webp / gif / svg(`image/svg+xml`)/ woff / woff2 / ttf / otf / mp4 / webm / mov / m4a / mp3 / wav / txt;其余 `application/octet-stream`。路径要 `decodeURIComponent`,并拒绝 `..` 逃出根目录。
5. **字体**:`src/fonts.ts` 是构建期扫描,静态包只认构建时有的字体。静态模式下脚本自己扫 `<ROOT>/src/assets/fonts/*.{ttf,otf,woff,woff2}`,按同一套命名规则(文件名去扩展名 = 家族名;结尾 `-三位数字` = 字重,没写就是 400)生成 `@font-face`,`src:url("/src/assets/fonts/<encodeURIComponent(文件名)>")`,在 `goto` 之后、`document.fonts.ready` 之前用 `page.addStyleTag({content})` 注入。和 bundle 里已有的声明重复无害。
6. **不改** `vite.config.ts`、不改 `src/`。desktop 的 `prepare-runtime.mjs` 负责在 `runtime/app` 里跑 `npx vite build`(任务 H)。

### G. 并行导出 + 自动缩放

已核实的事实:每帧状态 = 显式下发的绝对时间 t(`__setExportT`)+ 每个 CSS 动画**累加**的 `currentTime`(脚本每帧手动 `+intervalMs`)。
所以负责 [a, b) 的工作器必须从第 1 帧「快进」到 a:每帧照做 `__setExportT`、`__seekVideos`、等帧图、推进虚拟时间、动画 `+intervalMs`、**截图**,
唯一省掉的是「把 1920×1080 的 PNG 编码并写到盘上」。为什么连截图都不能省,见下面 G5。

1. **选项**:job 字段 `workers`(`"auto"` 或正整数)或环境变量 `OVERLAY_EXPORT_WORKERS`;默认 `auto`。`workers=1` 走原来的循环,不许有任何差异。
2. **环境上限**(auto 时先算,打一行日志):`cores = os.availableParallelism()`,`freeMB = os.freemem()/2^20`;
   `maxByCpu = max(1, floor(cores/4))`,`maxByMem = max(1, floor((freeMB - 1024)/600))`,`max = clamp(min(maxByCpu, maxByMem), 1, 6)`。
   `totalFrames < 300` 或 `max == 1` → 直接 `workers = 1`,不探测。
3. **探测**:主页面先照常渲染第 1..K 帧(`K = min(60, totalFrames)`),每帧分别计时「步进」(下发 t + 等帧图 + 推虚拟时间 + 动画步进)和「截图」;取第 11..K 帧的平均得 `c_ff`、`c_shot`,`c_frame = c_ff + c_shot`。
   另记 `c_start` = 从 `puppeteer.launch` 到 `__startExport` 调用完成的秒数(主页面实测)。
4. **规划**:剩余 `R = total − K`。对 N = 1..max 求分段长度 L_0..L_{N-1}(整数,和为 R)使各工作器同时完成:
   `T_0 = L_0·c_frame`(主页面接着渲染,不重启);`T_i = c_start + (s_i − 1)·c_ff + L_i·c_frame`,`s_i = K + 1 + Σ_{j<i} L_j`。
   用二分找 T 使 Σ L_i = R;`wall(N) = T`。取 wall 最小的 N;只有 `wall(N) < 0.85·wall(N−1)` 才允许多开一个;任一 `L_i < 30` 则这个 N 作废。
   把每个 N 的预测秒数打成一张表写进日志,最后一行写选定的 N 和分段。
5. **执行**:主页面继续渲染 `K+1 .. K+L_0`;工作器 i(1..N−1)各自 `puppeteer.launch`(同一套 LAUNCH_OPTS 和页面准备 —— 把页面准备抽成 `openRenderPage()` 供主页面和工作器共用),快进到 `s_i` 后渲染 `L_i` 帧,直接写 `outDir/frame_%06d.png`(全局帧号)。`Promise.all` 并发。

   **快进除了「不把 PNG 写到盘上」之外,必须和渲染路径逐步一致。** 2026-09-06 实测教训:
   上一版快进砍掉了 `__seekVideos` 和 `page.screenshot()`,结果每个工作器的分段起点 `s_i`
   之后会出现**约 30 帧连续不一致**(块的起点精确等于 `s_i`,块长等于当时在途的进场过渡时长,
   过渡结束后重新收敛;`s_i` 一动块就跟着动)。原因是截图会同步走完 layout→paint→composite、
   顺带跑掉一批 rAF 回调,不截图时同一段虚拟时间里页面产生的 rAF/paint 次数就变了,
   `useEnter` 的两层 rAF 于是在不同的帧上翻。
   **对照实验**(demo 编排、duration=20 → 599 帧、静态、workers=3、分段起点同为 266/436):
   旧快进在窗口 `[266, 306)` 对两次独立串行都是 30/40 帧不一致;改成「快进也截一张」后同一窗口
   0/40。做法是 `page.screenshot({ omitBackground: true, type: "jpeg", quality: 0, optimizeForSpeed: true })`
   —— 不写 `path` 就不落盘,低质 JPEG 比 PNG 编码快一个量级,而整幅画面照样被强制光栅化。
   **不能用 `clip: {0,0,1,1}` 省这笔钱**:Chrome 只光栅化 clip 覆盖到的那一块,视口其余部分
   不会真的画,视频帧图在快进期间就一直没被解码 —— 实测带视频卡的编排(`focus-card` + `camSrc`、
   345 帧、workers=3)clip 版稳定差 3 帧(199、266-267,266 正是工作器 2 的分段起点),
   换成整幅 JPEG 后 345/345 全等。
   代价是 c_ff 略升(实测 600 帧 3 工作器整轮从 42.9s → 55.1s,仍快于串行的 60.1s),
   但 c_ff 仍远小于 c_shot,G4 的规划模型不用改。
   同理,`__seekVideos` 也必须在快进里照做:否则快进全程 `img[data-fx-vidimg]` 的 src 一直为空,
   布局与串行不同,带视频卡的编排会在边界处以同样的机理出错。
   (推论:上一版为此加的 `warmVideoFrames()` 预热已经删掉 —— 快进每帧都换图之后,
   分段第一帧和串行走到同一帧时处境相同,那一轮预热反而是串行路径没有的一次额外 `__setExportT`。)
6. **进度**:共享计数器,每完成 30 帧和最后一帧打 `progress <done>/<total>`(vite 中间件按这个格式解析,不能改)。开头多打一行 `workers: N`。
7. **失败**:任一工作器抛错 → 关掉所有浏览器,按现在的逻辑清 PNG、退出 1、带人话原因。`waitBudgetExpired` 的 30 秒看门狗每个工作器都要有。
8. 渲染全部完成后 `framesDone = true`,`camSegs` 仍从主页面取,合成阶段一行不改。

### H. desktop 侧

1. `scripts/prepare-runtime.mjs`:`npm ci` 之后在 `runtime/app` 里跑 `npx vite build`,断言 `runtime/app/dist/index.html` 存在;`--check` 也查它;`VERSIONS.json` 加 `dist: true`。
2. `src-tauri/src/lib.rs` sidecar 环境变量表加两行:`OVERLAY_EXPORT_STATIC_DIR = <runtime>/app/dist`、`OVERLAY_EXPORT_WORKERS = auto`。「运行时环境」表同步。
3. README「升级上游」一节补一句:上游改了 export-frames.mjs 要重新合入静态模式和并行这两块。

### V. 验证工具与验收

1. 新建 `desktop/scripts/verify-export-modes.mjs`:对同一份编排(默认 `runtime/app/public/demo/demo-overlay.json`,可传路径)
   用 `keepFrames: true` 跑四种组合:服务器模式 × workers=1(基线)、静态 × 1、静态 × auto、静态 × 固定 4。
   **每种组合至少跑 2 次**(要给出各自的噪声集,而不是拿 1 次去和基线比)。
   逐帧 sha256 之外还要单独输出:每个工作器分段起点 `s_i` 之后 40 帧的差异率,并和「同配置重跑」
   的同区间差异率对比。打印每种组合的耗时、选定的 N、不一致的帧号。
   服务器模式需要 5177 上有 Vite:脚本自己起 `runtime/app` 的 vite(`--host 127.0.0.1 --port 5177 --strictPort`,`BROWSER=none`),跑完关掉。
2. 验收标准(按本节开头「第二轮」的新红线判定,不是逐帧全等):
   - **边界零差异**:任一分段边界窗口 `[s_i, s_i+40)` 有差异 → 退出码 1(这是硬失败);
   - **噪声包络**:静态×1 / 静态×N 对基线的差异帧数 ≤ `max(1.5 × 基线自噪声, 基线自噪声 + 10)`;
   - **严格逐帧**:`chapter-bar + caption-track` 子集编排在静态×1 ×2 与静态×N 之间逐帧全等;
   - 静态 × auto 比基线快;导出期间 `netstat` 上 Chrome 没有新的监听端口,Chrome 命令行含 `--remote-debugging-pipe`;
   - 装好的包里点导出成功、成品落到「视频\Overlay Studio\output」。
3. 结果写进 `BUILD-REPORT.md` 第 7 节:四种组合的耗时表、自动缩放的决策日志、环境上限、遗留问题。

### 安装包补充(2026-09-06):卸载钩子

`bundle.windows.nsis.installerHooks: "./nsis/hooks.nsh"`,里面只定义 `NSIS_HOOK_PREUNINSTALL`:删 `runtime\app\node_modules\.vite`、`.vite-temp`、`public\_fxframes`、`app\dist`、`app\exports` 这几个运行期生成的缓存目录。
**故意不整目录删 `runtime\`**:用户放的字体(`runtime\app\src\assets\fonts`)和导入的素材(`runtime\app\public\_media`)在同一棵树下,卸载不替用户删文件;顶层目录因此可能非空留下,属预期。
