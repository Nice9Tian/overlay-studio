# Overlay Studio 桌面壳 · 集成验收报告(任务 E)

- 验收时间:2026-09-05 深夜 ~ 2026-09-06 凌晨
- 机器:Windows 11 Pro 26200,x64
- 版本:`desktop/package.json` 与 `tauri.conf.json` 同为 **1.1.1**
- 依据:`desktop/DESIGN.md`「集成验收(任务 E)」

结论:**通过**。release exe 能启动、能进编辑台、能导出透明 MOV,退出后无残留进程;
NSIS 安装包已产出并通过静默安装 → 启动 → 卸载的最小验证。详见下面逐项。

---

## 1. 检查项逐条结果

### 1.1 runtime 对齐

| 项 | 结果 |
|---|---|
| `node scripts/prepare-runtime.mjs --check`(改前) | **失败(预期内)**,退出码 1,报「runtime/app 落后于 motion-playground」 |
| `npm run prepare-runtime` | 通过 |
| `node scripts/prepare-runtime.mjs --check`(重跑后) | **通过**,退出码 0 |

原因就是任务 C 的执行者已经预告过的时序问题:`runtime/app` 是 19:35 从 `motion-playground`
拍的快照,任务 A 在 19:38 又改了一次 `scripts/export-frames.mjs`。重跑一次即对齐。

`runtime/` 实测体积(复制进 `target/release/` 后同):

| 目录 | 体积 |
|---|---|
| `runtime/app` | 134.5 MB |
| `runtime/chrome` | 418.7 MB |
| `runtime/ffmpeg` | 423.8 MB |
| **合计** | **约 977 MB** |

`VERSIONS.json`:node `v24.19.0`、chrome `150.0.7871.24`、
ffmpeg `9.0.1-full_build-www.gyan.dev`、app `1.1.1`。

### 1.2 release 编译

| 项 | 值 |
|---|---|
| 命令 | `npx tauri build --no-bundle` |
| 结果 | **通过** |
| 产物 | `%USERPROFILE%\Documents\overlay-studio\desktop\src-tauri\target\release\overlay-studio.exe` |
| 体积 | **11.5 MB** |
| 耗时 | 约 **70 秒**(deps 首个产物 23:59:22 → exe 00:00:32) |

关于耗时的一个诚实说明:DESIGN.md 预估首次 cargo release 编译 5–15 分钟,本次只用了约 70 秒。
`target/` 里在任务 B 阶段已经有过一轮编译,依赖大概率是热的,**别拿这 70 秒当另一台干净机器的预期**。
改完 `tauri.conf.json` 之后的增量重编是 26.4 秒。

另外 `tauri build` **会**把 `bundle.resources` 里的 `runtime/` 复制进 `target/release/`,
所以跑 release exe 不需要设 `OVERLAY_RUNTIME_DIR`(契约里那条开发期例外这次没用上)。

### 1.3 启动冒烟(release exe)

命令:`node scripts/smoke-all.mjs`(见下面「本轮新增的脚本」)

```
BOOT_RESULT_JSON {"ok":true,"readySec":2.8,"windowTitle":"Overlay Studio",
                  "mainPids":[34904],"sidecarPids":[37308],"htmlBytes":1030}
```

| 检查 | 结果 |
|---|---|
| 主程序进程存在、窗口标题为 `Overlay Studio` | **通过** |
| `GET http://127.0.0.1:5177/` 返回 200 且 HTML 含 `Overlay Studio` | **通过**(1030 字节,是真正的编辑台:带 `/@vite/client` 和 react-refresh) |
| 进程树里有 node sidecar | **通过**(主程序后代 8 个进程:`msedgewebview2.exe`×6、`node.exe`×1、`conhost.exe`×1) |
| 就绪耗时 | **2.8 秒**(契约要求 10 秒内切到编辑台) |

`sidecar.log` 里能看到 `VITE v8.1.4 ready in 152 ms`,日志转发正常。

> 一个排查时踩过的坑,记下来免得下次再花时间:`Get-ChildItem` 看到的 `sidecar.log`
> 大小和修改时间会一直停在上一次的值。这是 NTFS 对**有打开句柄的文件**不及时刷新目录项造成的,
> 不是日志没写。要看真实内容得用共享读方式打开它,别据此判断日志功能坏了。

### 1.4 导出冒烟

命令:`node scripts/smoke-export.mjs`,用 `runtime/app/public/demo/demo-overlay.json`
整条时间轴(10 张卡,时长 28.5 秒,29.97fps)。

```
SMOKE_RESULT_JSON {"ok":true,"elapsedSec":85.2,"frames":854,"fps":29.97,
  "outDir":"C:\\Users\\admin\\Videos\\Overlay Studio\\output",
  "files":[{"name":"timeline-20260905151014.mov","sizeMB":261.9},
           {"name":"timeline-20260905151014.webm","sizeMB":1.7}]}
```

| 检查 | 结果 |
|---|---|
| `POST /api/export` 返回 200 且 `ok:true` | **通过** |
| `/api/export-status` 阶段推进 | **通过**(`frames` → `mov` → `webm` → `done`) |
| 逐帧渲染 | **854/854 帧,约 55 秒**(约 15fps) |
| 成品落到 `%USERPROFILE%\Videos\Overlay Studio\output\` | **通过** |
| 全程耗时 | **85.2 秒** |

成品实测(`ffprobe`),确认不是「能出文件但坏片」:

```
codec_name=prores  codec_tag_string=ap4h        ← ProRes 4444
pix_fmt=yuva444p12le                            ← 带 alpha 通道
width=1920 height=1080
r_frame_rate=30000/1001                         ← NTSC 精确分数,不是 29.97 小数
nb_frames=854  duration=28.495133  size=274609031
```

这一条同时验证了三件本来最容易出问题的事:**内置 Chrome 起得来**(虚拟时间逐帧截图)、
**内置 ffmpeg 能合成**(PATH 注入生效)、**`OVERLAY_EXPORT_DIR` 生效**(成品没落进安装目录)。

### 1.5 退出无残留

```
SHUTDOWN_RESULT_JSON {"ok":true,"killedMain":[34904],"treeSizeBeforeKill":8,
                      "leftover":[],"leftoverNodes":[],"leftoverChromes":[]}
```

`taskkill /F /T` 一次收掉主程序及其全部 8 个后代进程,5 秒后复查零残留。契约第 8 条成立。

> 这一项第一次跑出来是「失败」,查下来是**我自己的检查脚本写错了**,不是程序的问题:
> 早期版本按映像名数 `node.exe` / `chrome.exe`,于是把这台机器上 Adobe Creative Cloud 自带的
> `node.exe`、以及跑验收的脚本自己(也是 node.exe)一并算成了「本次启动的残留」。
> 已改成只认主程序 exe 的**后代进程**(`scripts/smoke-procs.mjs`),重跑通过。
> 换台机器复验时请用现在这版,老口径必然误报。

---

## 2. 交付物

### 2.1 NSIS 安装包(本轮交付物)

```
%USERPROFILE%\Documents\overlay-studio\desktop\src-tauri\target\release\bundle\nsis\Overlay Studio_1.1.1_x64-setup.exe
```

| 项 | 值 |
|---|---|
| 体积 | **295.7 MB** |
| 打包耗时 | `npx tauri build` 全程 **402 秒**;其中 makensis 压缩约 **373 秒**(单线程 LZMA 压 977MB) |
| 压缩比 | 977 MB → 295.7 MB(约 30%) |
| 装出来占地 | **1077.1 MB** |
| 安装模式 | `currentUser`(装进 `%LOCALAPPDATA%`,不要管理员) |

因为 NSIS 这条路走通了,**没有**启用便携 zip 的退路。

### 2.2 最小安装验证

命令:`node scripts/smoke-install.mjs`(静默装到 `%TEMP%\ovs-install-test` → 启动冒烟 → 静默卸载)

```
INSTALL_RESULT_JSON {"installerMB":295.7,"installSec":24,"installedMB":1077.1,
  "appExe":"C:\\Users\\admin\\AppData\\Local\\Temp\\ovs-install-test\\overlay-studio.exe",
  "smokeOk":true,"uninstallClean":false,"leftovers":["runtime"]}
```

| 检查 | 结果 |
|---|---|
| `/S /D=<临时目录>` 静默安装 | **通过**,退出码 0,耗时 24 秒 |
| 安装目录内容 | **正确**:`overlay-studio.exe`、`node.exe`(sidecar)、`runtime\`、`uninstall.exe` |
| 从安装目录启动 | **通过**,窗口标题 `Overlay Studio`,**2.8 秒**进编辑台,5177 返回真编辑台 HTML |
| 退出无残留 | **通过**,主程序 + 8 个后代进程全收干净 |
| `uninstall.exe /S` 静默卸载 | **通过**,退出码 0 |
| 卸载后清理 | **基本干净**,见下面「遗留问题」第 1 条 |

### 2.3 装出来的那份也跑了一遍完整导出

上面 1.3–1.5 是对 `target/release` 里的 exe 做的。为了不让「能导出」这个结论停在
「未打包的那份能导出」上,又对**真正装出来的那份**(从 NSIS 包装到临时目录)
跑了一遍完整的启动 + 导出 + 退出:

```
ALL_RESULT_JSON {"exe":"C:\\Users\\admin\\AppData\\Local\\Temp\\ovs-final-test\\overlay-studio.exe",
                 "boot":true,"export":true,"shutdown":true}
SMOKE_RESULT_JSON {"ok":true,"elapsedSec":90.2,"frames":854,"fps":29.97,
  "files":[{"name":"timeline-20260905153832.mov","sizeMB":261.9},
           {"name":"timeline-20260905153832.webm","sizeMB":1.7}]}
```

启动 **2.7 秒**,导出 854 帧 **90.2 秒**,成品同样落在 `视频\Overlay Studio\output`,
退出零残留。**这一条是「拷到别的机器上能用」最直接的证据**:装出来的包里的内置 Node、
内置 Chrome、内置 ffmpeg 三样全部真实跑通了。

顺带核实了任务 B 留下的那个待确认问题(中文发行者能不能正常显示)——**能**。
另装一次(不启动程序)后读注册表:

```
DisplayName    : Overlay Studio
Publisher      : 一页枝鸥          ← 中文发行者在 NSIS Unicode 下渲染正常
DisplayVersion : 1.1.1
EstimatedSize  : 1102974 (KB)
```

开始菜单和桌面快捷方式都建了;这一次(程序没跑过)卸载之后**安装目录、注册表项、
开始菜单快捷方式、桌面快捷方式四样全部消失,零残留**。

---

## 3. 本轮修改过的文件

### 3.1 修的构建故障(1 处,这是唯一挡住打包的问题)

**`desktop/src-tauri/tauri.conf.json`** — `bundle.windows.nsis.languages`:
`"SimplifiedChinese"` → **`"SimpChinese"`**

第一次 `npx tauri build` 就死在这儿:

```
Error: Can't open language file - "...\tauri\NSIS\Contrib\Language files\SimplifiedChinese.nlf"!
Error in macro MUI_LANGUAGEEX on macroline 13
failed to bundle project: `Failed to bundle app with makensis`
```

NSIS 官方的简体中文语言文件就叫 **`SimpChinese.nlf`**(繁体是 `TradChinese`),
根本没有 `SimplifiedChinese` 这个名字。Tauri 只是把这个字符串原样传给
`!insertmacro MUI_LANGUAGE`,所以配置阶段不报错,一直拖到 makensis 才炸。
改对之后,`Warn Custom tauri messages for SimplifiedChinese are not translated` 这条警告
也一并消失了 —— 说明 `SimpChinese` 同时也是 Tauri 自带翻译用的键名,是完全正确的写法。

**`desktop/DESIGN.md`** —「安装包」一节里 `languages: ["SimplifiedChinese", "English"]`
同步改成 `["SimpChinese", "English"]`。契约开头写着「改契约先改这里,再改代码」,
而这是一个客观的名字错误(NSIS 里不存在这个标识符),不改的话下一个照契约生成配置的人
会原样再撞一次同样的失败。

### 3.2 新增的验收脚本(`desktop/scripts/`)

这些是本轮为了做验收写的,可以重复跑,换机器复验时直接用:

| 文件 | 作用 |
|---|---|
| `smoke-procs.mjs` | 进程树工具:按父子关系找主程序的后代进程 |
| `smoke-boot.mjs` | 启动冒烟:窗口标题 / 5177 编辑台 / sidecar 子进程 |
| `smoke-export.mjs` | 导出冒烟:跑 demo 整条时间轴,查成品落盘 |
| `smoke-shutdown.mjs` | 退出检查:`taskkill /F /T` 后核对整棵进程树无残留 |
| `smoke-all.mjs` | 把上面三步串起来(`--skip-export` 可只跑启动和退出) |
| `smoke-install.mjs` | 安装包验证:静默装 → 冒烟 → 静默卸载 → 查残留 |

常用命令:

```powershell
node scripts/smoke-all.mjs                 # 验收 target/release 里的 exe(含导出,约 2 分钟)
node scripts/smoke-all.mjs --skip-export   # 只验启动和退出(约 15 秒)
node scripts/smoke-install.mjs             # 验收 NSIS 安装包(约 1 分钟)
```

**没有改动** `motion-playground/` 下的任何文件,也没有改 Rust 代码。除上面两处外,
`desktop/` 下其余文件保持任务 A–D 交付时的样子。本轮全程未 `git commit`。

---

## 4. 遗留问题

1. **卸载残留(小,本轮按要求未修)**:程序**跑过之后**再卸载,`<安装目录>\runtime` 会留下来。
   实测残留正好是 Vite 运行时生成的依赖预构建缓存:
   `runtime\app\node_modules\.vite\`(以及空的 `.vite-temp\`),13 个文件共 **2.4 MB**。
   原因很清楚:NSIS 卸载器只删自己装进去的文件,这些是运行期新生成的,它不认识,
   于是目录非空、`RMDir` 删不掉。**程序没跑过就卸载则是零残留**(上面验过)。
   两个可选修法,任选其一:卸载脚本里加 `RMDir /r "$INSTDIR\runtime"`;
   或者给 Vite 配 `cacheDir` 指到安装目录外面(比如 `%LOCALAPPDATA%`)。

2. **首次 cargo release 编译耗时不可外推**:本机 70 秒是因为 `target/` 已被任务 B 预热过。
   干净机器上按 DESIGN.md 的 5–15 分钟预期。

3. **NSIS 打包是单线程 LZMA**,压 977MB 要 6 分多钟,而且这段时间没有任何进度输出,
   看起来像卡死。如果嫌慢,`bundle.windows.nsis` 可以调 `compression`,代价是安装包变大。

4. **验收产物留在了用户的视频目录**:`%USERPROFILE%\Videos\Overlay Studio\output\` 下有
   **两组**测试成品(一组来自 `target/release` 的 exe,一组来自装出来的那份),
   `timeline-20260905151014.*` 和 `timeline-20260905153832.*`,合计约 **527 MB**。
   内容是同一段 demo,留着是作为验收证据;确认没问题后可以自行删掉。

5. **验收脚本自身踩过两个坑,已修,记下来免得复验时再中招**:
   一是按映像名数进程会把机器上无关的 `node.exe`/`chrome.exe` 算成残留(已改成按进程树);
   二是安装刚返回就启动会抢在 NSIS 写完文件之前,程序弹「无法启动内置 Node」模态框,
   表现成「窗口在、5177 永远不通」,极像程序 bug(已改成等关键文件齐 + 目录大小稳定)。

6. **没有代码签名**,首次运行会被 SmartScreen 拦(下一节有处理办法)。契约里本来就写明不签名。

---

## 5. 怎么在另一台机器上测

把这一个文件拷过去就行:

```
Overlay Studio_1.1.1_x64-setup.exe   (295.7 MB)
```

**目标机器需要什么**

- Windows 10 / 11,**x64**(只做了 x64,ARM 机器不行);
- WebView2 运行时 —— Win10 较新版本和 Win11 都自带;万一没有,安装包配的是
  `downloadBootstrapper`,装的时候会自己联网拉;
- 磁盘留 **1.2 GB** 以上(安装包 296 MB + 装出来约 1.08 GB);
- **不需要**装 Node、不需要装 ffmpeg、不需要装 Chrome、不需要命令行 —— 全都在包里。

**装和跑**

1. 双击安装包。没有签名,SmartScreen 会弹「Windows 已保护你的电脑」——
   点**「更多信息」→「仍要运行」**。
2. 装到 `%LOCALAPPDATA%`,**不需要管理员权限**。装完开始菜单和桌面都有「Overlay Studio」。
3. 双击图标。先看到「正在启动 Overlay Studio…」的转圈页,几秒后自动切进编辑台
   (本机实测 2.8 秒;冷启动的机器慢一些,超过 90 秒才会报超时)。

**导出的东西在哪**

`视频 \ Overlay Studio \ output\`(即 `%USERPROFILE%\Videos\Overlay Studio\output`)。
成品是透明 ProRes 4444 的 `.mov`(剪映直接拖)和小体积的 `.webm`。
**故意不放在安装目录**,所以卸载软件不会连成品一起删。

程序里也有入口:菜单**「文件 → 打开导出成品文件夹」**。

**出问题怎么查**

菜单**「帮助 → 查看运行日志」**,会打开日志目录,里面的 `sidecar.log` 记着内置 Node
和 Vite 的全部输出,启动失败/导出失败的真正原因都在这儿。
路径是 `%LOCALAPPDATA%\com.overlaystudio.desktop\logs\sidecar.log`。

> 看这个文件时注意:资源管理器显示的大小和修改时间可能是旧的(程序正开着它),
> 这是 Windows 的正常行为,**不代表日志没写**,用记事本打开看内容为准。

**想验得更彻底一点**,可以把 `desktop/scripts/` 拷过去(需要目标机器有 Node)跑:

```powershell
node scripts/smoke-install.mjs "<安装包路径>"
```

一条命令跑完:静默安装 → 启动 → 5177 编辑台检查 → 退出残留检查 → 静默卸载。

---

## 6. 追加(2026-09-06 凌晨):导出时的空窗口 + 页面弹窗失效

### 6.1 现象与根因

**空窗口。** 用户反馈点导出后桌面左上角出现一个 780×580 的空黑窗口,导完才消失。
用系统 API 枚举得到它的身份:标题 `Overlay Studio - Google Chrome for Testing`,进程是导出脚本
拉起的 Chrome for Testing 150。根因是 Chrome 新无头模式(`--headless=new`)在 Windows 11 上
会把这个本应隐藏的窗口画出来(Chrome 129 起的已知问题,puppeteer #13145 / selenium #14550)。
隔离实验:不经过 Overlay Studio,直接用包里的 chrome.exe 跑 `--headless=new about:blank`,
同样的窗口出现在同样的位置 —— 和 Tauri 壳无关,命令行版在这台机器上也一样。

**弹窗失效。** 日志里有一串 `Command plugin:dialog|confirm not allowed by ACL` /
`plugin:dialog|message not allowed by ACL`。`tauri-plugin-dialog` 会往每个页面注入脚本,把
`window.alert` / `window.confirm` 换成走 IPC 的异步版本;编辑台是远程地址,IPC 被 ACL 拒掉,
于是导出完成的文件清单、导入失败原因等所有 alert 静默消失。就算放行 ACL 也不行:confirm
变异步后,页面里 `if (!confirm(...)) return` 这类同步守卫永远不拦,「清空编排」会不经确认直接执行。

### 6.2 改动

| 文件 | 改动 |
|---|---|
| `motion-playground/scripts/export-frames.mjs` | puppeteer 启动参数加 `--window-position=-32000,-32000`(带注释) |
| `desktop/src-tauri/Cargo.toml` | 去掉 `tauri-plugin-dialog`,加 `rfd = "0.16"`(插件底下用的就是它,不新增下载) |
| `desktop/src-tauri/src/lib.rs` | 新增 `native_message()`,端口被占 / Node 起不来 / 关于 三处对话框改用 rfd;编辑台地址改为常量 `EDITOR_URL = http://127.0.0.1:5177/` |
| `desktop/src-tauri/capabilities/default.json` | 去掉 `dialog:default` |
| `desktop/DESIGN.md` | 「上游改动」加 3a;「Rust 行为」第 5 条改 127.0.0.1 并说明原因;新增第 11 条「不装 dialog 插件」;crate 清单同步 |
| `desktop/README.md` | 升级上游一节补上 `--window-position` 这一行的漏合后果 |

编辑台地址为什么从 `localhost` 改成 `127.0.0.1`:sidecar 只监听 IPv4;`localhost` 在 WebView2 里可能先解析成
`::1`,本机若恰好有别的程序监听 `[::1]:5177`(开发期另起的 vite 就会),窗口会连到错的服务上,界面一样、导出却跑在别处。
**副作用**:WebView2 把新地址当成新站点,桌面版的 localStorage 从零开始 —— 授权协议页会重新出现一次,时间轴为空。
浏览器版和之前的存档不受影响。

### 6.3 验证(装好的那份,`%LOCALAPPDATA%\Overlay Studio`)

| 检查 | 结果 |
|---|---|
| 导出中枚举 Chrome 窗口位置 | `-32000,-32000`,780×580 |
| 导出中抓屏幕左上角真实像素(不经截图工具遮罩) | 只有桌面图标,没有黑窗口 |
| 导出结果 | 854 帧,MOV 213MB + WebM 1.2MB 落到「视频\Overlay Studio\output」 |
| 关闭后残留进程 | 0 |
| 新版启动后日志里的 ACL 错误 | 0(旧的 19 条全在改动前) |
| 原生 confirm 弹窗 | **通过**:用户过了授权协议页后,时间轴有卡时点「示例」,弹出 WebView2 自带的同步对话框「127.0.0.1:5177 显示:载入示例会替换当前编排(可撤销),继续吗?」,带确定/取消;点取消后编排原样保留 |

### 6.4 顺手发现并处理的

- NSIS 静默安装会沿用注册表里上一次的 `InstallLocation`。集成验收时装到 `%TEMP%\ovs-final-test` 的那份
  没卸干净,导致这次 `/S` 静默重装被带到了临时目录、快捷方式也指过去。已把临时目录那份卸载,
  用 `/S /D=%LOCALAPPDATA%\Overlay Studio` 重装,注册表和桌面快捷方式现在都指向正确位置。
  教训:测试安装用完必须卸载;发行安装最好显式给 `/D=`。
- 开发期用 launch.json 起的 vite(监听 `[::1]:5177`)会和壳抢地址,验证前要停掉。

### 6.5 安装包

```
%USERPROFILE%\Documents\overlay-studio\desktop\src-tauri\target\release\bundle\nsis\Overlay Studio_1.1.1_x64-setup.exe
```

295.6MB,02:11 构建。版本号未变(1.1.1),外发前建议改成 1.1.2 以便区分。
