# AI 助手 · 设计契约(第七轮:P1–P4 并行,P5 主 Agent 接线)

仓库根 `%USERPROFILE%\Documents\overlay-studio\motion-playground`,下文路径都相对它。
用户原话:「现在左侧全局菜单没有了,可以把参数菜单栏移动到左侧菜单栏下半部分。右侧菜单栏改为“AI助手”。连接 ClaudeCodeCLI、agyCLI 或者 Codex。软件创建一个 MCP 协议让 AI 可以和他交互。比如用户可以在聊天输入框点“+”导入一条视频,要求 AI 根据视频内容创建字幕文件,然后 AI 自动把字幕文件通过 MCP 导入素材库。或者用户描述他要一个怎样的卡片,AI 根据卡片的制作(基于 XX,使用什么语法)来创建一个新的卡片形式导入素材库。」

## 0. 边界(每个任务都要守)

- **别的会话正在改**(2026-09-06 06:50 更新):「界面 (fork)2」接下来约 1 小时在改 `src/App.tsx`、`src/components/Sidebar.tsx`、`src/components/TopBar.tsx`、`src/main.tsx`、**整个 `src/library/*`**(素材库从独立窗口改成左栏顶级分页,新契约 `LIBRARY-TAB-DESIGN.md`;旧的 `LibraryWindow.tsx / bus.ts` 已归档到 `legacy/library-window/`,**不存在了**,`legacy/` 只读);`src/App.css`、`src/components/ParamsPanel.tsx` 留给 P5;`vite.config.ts`、`scripts/**`、`desktop/**` 归「工程目标分析」。**P1–P4 一律不碰这些文件**,由 P5(主 Agent)在别的会话交还后统一接线。看到这些文件里有半成品(编译不过、没人用的 import)当没看到,不要「顺手修」。
- **不许 import `src/library/bus.ts`**(已删)。素材登记表的变化通知现在是 `assets.ts` 的 `subscribeAssets(cb)`;预设的通知照这个样子做在自己的模块里(§6.2)。
- **失败安全**(桌面壳的 sidecar 就是用 vite.config.ts 起的 Vite,任何一个插件在加载时抛错,整个桌面版起不来):`server/**` 的模块顶层不许有会抛错的代码(找不到 CLI、目录不存在都只能在请求到来时报 JSON 错误);所有 `spawn` 失败必须捕获;子进程一律 `windowsHide: true`(sidecar 是 CREATE_NO_WINDOW 起的,不加会弹黑窗)。前端代码(`src/**`)不许 import `server/**`(`vite build` 的产物里不该有它)。
- **不跑任何 git 命令**(「界面」会话正在本地连续提交,index.lock 会撞)。
- 只在下面「文件归属」列出的自己的文件里写;需要别人的东西就按本契约里的接口写,接口不够用就在自己的报告里提,不要改别人的文件。
- 不新增 npm 依赖(package.json 不动;桌面壳会把 runtime/ 打包,依赖变化要走别的会话)。服务端只用 Node 内置模块;前端只用 React。
- 验证:`npx tsc -p tsconfig.app.json --noEmit` 和 `npm run lint`(基线:App.tsx 里可能有别的会话的临时错误,只看自己文件的错误)。服务端脚本用 `node --check` 和自己写的冒烟脚本。
- 端口:**5177 是用户正在用的桌面版,不许碰**;**5199 是别的会话起的 vite,只能开页面看,不许重启**(fork2 改造期间会短暂白屏,不是你的问题);**5198 / 5197 是「工程目标分析」的备用口,不许用**;本轮自己测试只用 **5196**(P1 的 `server/vite.ai.config.ts`),用完必须把进程杀掉。
- 命令行环境:每条命令前置 `$env:Path = "C:\Program Files\nodejs;" + $env:Path`(node 不在会话 PATH 里)。CLI 位置:`claude` = `%USERPROFILE%\.local\bin\claude`(2.1.221)、`agy` = `%USERPROFILE%\AppData\Local\agy\bin\agy.exe`(1.1.27)、`codex` = `%USERPROFILE%\AppData\Local\Programs\OpenAI\Codex\bin\codex`(0.136.0)、`ffmpeg` 在 PATH(9.0.1)。
- **安全红线**:任何情况下不用、不建议 `--dangerously-skip-permissions`(claude / agy)和 `--dangerously-bypass-approvals-and-sandbox`(codex)。不读、不打印 `~/.codex/config.toml`、`~/.claude/settings.json` 等含密钥的文件内容。AI 对话只允许用我们自己的 MCP 工具,不给它 shell / 文件读写工具。
- 颜色、字体一律用 `src/index.css` 的变量:`--bg-app --bg-panel --bg-elev --bg-canvas --hairline --hairline-strong --ink --ink-muted --ink-faint --accent --on-accent --danger --fill-hover --fill-subtle --font-sans --font-mono`。
- 页内提示不用 `alert/confirm`(内嵌浏览器会吞),用组件内的提示条;需要确认用 `src/components/ConfirmDialog.tsx`。

## 1. 目标与两条示范流程

右栏从「单卡参数」改成「AI 助手」聊天面板;参数面板搬到左栏下半部分(上半是轨道页签 + 卡片列表)。AI 是本机装好的三种 CLI 之一(Claude Code / Antigravity `agy` / Codex),由软件后端以无头模式拉起;软件自带一个 **MCP 服务**(`server/mcp-server.mjs`,stdio),CLI 通过它读写正在运行的编辑台。

流程 A · 视频 → 字幕:用户点输入框的「+」选一个视频 → 前端走现有 `importVideoFile`(落盘到 `public/_media/`,登记进素材库「视频素材」)→ 消息里带上附件(站内 url + 磁盘路径)→ 用户说「根据视频内容做字幕」→ AI 调 `transcribe_video`(服务端:ffmpeg 抽音频 → 语音识别引擎 → SRT 文本)→ AI 调 `import_srt(name, srt_text, use=true)` → 编辑台登记字幕素材并用作本期字幕稿(自动生成字幕层卡)。
流程 B · 描述 → 新卡:用户说「我要一张……样子的卡」→ AI 调 `get_card_authoring_guide`(拿到自定义卡的写法)和 `list_effects`(看现有卡够不够用)→ 要么用现有 kind + 调好的 params,要么用 `custom-card`(HTML + CSS,Shadow DOM 隔离)→ 调 `create_preset(name, kind, params)` → 素材库出现一组「预设」,点「加到序列 n」即上时间轴;`add_card` 也可以直接放到时间轴。

## 2. 架构

```
浏览器(编辑台 App)                                 Vite dev server(同一进程,插件 server/ai-bridge.ts)
┌──────────────────────────┐   POST /api/ai/chat  ┌──────────────────────────────────────────┐
│ AiPanel (右栏聊天)        │ ───(SSE 流)────────▶ │ runners/*.mjs  spawn: claude -p / agy -p /  │
│ useAiChat                │ ◀──text/tool 事件─── │                codex exec  (无头,stdio)     │
│                          │                      │        │ CLI 按 MCP 配置拉起 ↓                │
│ mcpExecutor (EditorApi)  │ ◀─GET /api/mcp/events│ server/mcp-server.mjs (stdio JSON-RPC)      │
│  执行 add_card/import_srt│ ──POST /api/mcp/result│        │ HTTP POST /api/mcp/call ↓            │
│  …并回结果               │                      │ 桥:浏览器工具 → 转给编辑台等结果;            │
└──────────────────────────┘                      │     服务端工具(transcribe_video 等)本地做   │
                                                  └──────────────────────────────────────────┘
```

- 一个 dev server 同时只认**一个**编辑台页面(最后连上 `/api/mcp/events` 的那个;旧的收到 `{type:"replaced"}` 后断开)。
- MCP 服务进程是 CLI 的子进程,它怎么找到编辑台的端口:环境变量 `OVERLAY_STUDIO_PORT` > 锁文件 `%TEMP%\overlay-studio\port.json`(`{port, pid, startedAt}`,ai-bridge 在 server 监听后写)> 默认 5177。runner 拉起 CLI 时总是把 `OVERLAY_STUDIO_PORT` 传给 MCP 服务(Claude 用 mcp-config 的 env,Codex 用 `-c mcp_servers.…env`,agy 用 `agy mcp add -e`)。
- CLI 的工作目录固定 `exports/ai-workspace/`(不存在就建;`exports/` 已在 .gitignore 里,P5 确认)。AI 不需要文件工具:一切通过 MCP。

## 3. P1 · 服务端桥 + MCP 服务 + 语音识别(文件归属:`server/ai-bridge.ts`、`server/mcp-server.mjs`、`server/mcp-tools.mjs`、`server/stt.mjs`、`server/ai-system-prompt.md`、`server/vite.ai.config.ts`、`server/test/**`、`server/README.md`)

### 3.1 `server/ai-bridge.ts` —— Vite 插件 `export function aiBridge(): Plugin`

参照 `vite.config.ts` 里 `demoUpload()` 的写法:`configureServer(server)` 里 `server.middlewares.use('/api/…', handler)`。类型用 `import type { Plugin } from 'vite'`,`IncomingMessage/ServerResponse` 来自 `node:http`。运行时 import `./runners/index.mjs`(P2 的,接口见 §4;P1 开发期间先写一个同接口的假 runner 放在 `server/test/fake-runner.mjs`,靠环境变量 `OVERLAY_AI_FAKE_RUNNER=1` 切换,集成时默认走真的)。

端点(都只接本机;返回 JSON 时 `Content-Type: application/json`;错误 `{ ok:false, error }`):

| 端点 | 作用 |
|---|---|
| `GET /api/ai/providers` | `runners.listProviders()` 的结果 + `{ stt: { engine, available, hint } }`(见 3.4)|
| `POST /api/ai/chat` | 体:`{ provider:"claude"\|"agy"\|"codex", prompt:string, sessionId?:string, model?:string, attachments?: { url:string, name:string, kind:"video"\|"srt"\|"json"\|"other", text?:string }[] }`。响应是 **SSE**(`Content-Type: text/event-stream`,每条 `data: <json>\n\n`,先 `flushHeaders`,连接期间每 15 秒发一行 `: ping` 注释保活)。事件顺序:`{type:"run", runId}` → runner 的事件(§4 规范化事件原样转发)→ `{type:"done", …}` 或 `{type:"error", message}`。客户端断开 → abort 这次 run。|
| `POST /api/ai/abort` | 体 `{ runId }`,杀掉对应 run(`runner.abort()`),回 `{ok:true}` |
| `GET /api/mcp/events` | 编辑台的 SSE 长连接。连上先发 `{type:"hello", port}`;之后每个待执行的浏览器端工具调用发一条 `{type:"call", id, tool, args}`;被新页面顶掉发 `{type:"replaced"}` 后关闭。|
| `POST /api/mcp/result` | 体 `{ id, ok:boolean, result?:unknown, error?:string }`,喂给 pending 的 call |
| `POST /api/mcp/call` | mcp-server.mjs 打进来的:体 `{ tool, args }`。服务端工具直接做;浏览器端工具:没有编辑台在线 → `{ok:false, error:"编辑台没有打开:没有页面连着 /api/mcp/events"}`;在线 → 发给编辑台等结果,默认 60 秒超时(`transcribe_video` 是服务端工具,自己的超时 30 分钟)。回 `{ ok, result | error }`。|
| `GET /api/mcp/status` | `{ editorConnected:boolean, pending:number, port }`(调试用) |

prompt 组装(在桥里做,runner 只收最终文本):
1. 系统提示 = `server/ai-system-prompt.md` 全文(P1 写,内容见 3.5),Claude 走 `--append-system-prompt`,agy / codex 没有对应参数就拼在用户消息最前面,用 `<<<系统说明>>> … <<<用户消息>>>` 分隔。
2. 附件块:每个附件一行:`- [视频] 名字 · 站内地址 /_media/x.mp4 · 磁盘路径 C:\…\public\_media\x.mp4 · 时长 83.2 秒`(时长用 `stt.probeDuration`);`srt` 类附件把 `text` 原文附在代码块里(字幕文本不大);站内 url → 磁盘路径的换算:`path.join(ROOT, 'public', decodeURIComponent(url.split('?')[0]))`,必须落在 `public/` 之内(拒绝 `..`)。
3. 编辑台简况一行:`当前端口 5177;编辑台已连接/未连接`(未连接时提醒 AI 先请用户打开编辑台)。

### 3.2 `server/mcp-server.mjs` —— stdio MCP 服务(手写 JSON-RPC,不装 SDK)

- 传输:stdin 按行读 JSON(newline-delimited JSON-RPC 2.0),stdout 只写协议消息,**日志全部走 stderr**(stdout 混进一个字符协议就断了)。
- 方法:`initialize` → `{ protocolVersion: <客户端请求的版本,不认识就回 "2025-03-26">, capabilities:{ tools:{} }, serverInfo:{ name:"overlay-studio", version:"0.1.0" } }`;`notifications/initialized` 忽略;`ping` → `{}`;`tools/list` → `{ tools:[…] }`(来自 mcp-tools.mjs);`tools/call` → `POST http://127.0.0.1:<port>/api/mcp/call` → 成功 `{ content:[{ type:"text", text: JSON.stringify(result, null, 2) }] }`,失败 `{ content:[{type:"text", text: error}], isError:true }`;其他方法 → `-32601`。通知(没有 id 的请求)不回。
- 端口发现顺序见 §2。桥不在线(连接被拒)时 `tools/call` 返回 isError 文本「Overlay Studio 没在运行(端口 N 没有服务)」。
- 用 `node server/test/mcp-smoke.mjs` 自测:起子进程,喂 initialize / tools/list / tools/call(get_editor_state),校验回包结构。

### 3.3 `server/mcp-tools.mjs` —— 工具表(单一事实来源,桥和 MCP 服务都 import)

每项 `{ name, description, inputSchema, side: "browser" | "server" | "hybrid" }`。description 写给 AI 看,中文,说清什么时候用、参数单位(时间一律秒)。

| name | side | 入参 | 结果 |
|---|---|---|---|
| `get_editor_state` | browser | `{}` | `{ curT, duration, playing, videoUrl, srtName, trackCount, trackNames, cards:[{ id, kind, name, start, end, track, summary }], videoAssets:[{id,name,src,durationSec}], srtAssets:[{id,name,lines,duration}], presets:[{id,name,kind,description}] }` |
| `list_effects` | browser | `{}` | `[{ kind, name, description, group, tags, defaults, controls:[{key,label,type,min?,max?,step?,unit?,options?}] }]` |
| `get_card` | browser | `{ id }` | 整张卡(含 params) |
| `add_card` | browser | `{ kind, start, end?, track?, params? }` | `{ id, start, end, track }`;同序列同时段已被占用 → error 说明被谁占 |
| `update_card` | browser | `{ id, start?, end?, track?, params? }`(params 是合并补丁)| `{ ok:true }` |
| `remove_card` | browser | `{ id }` | `{ ok:true }` |
| `import_srt` | browser | `{ name, srt_text, use?:boolean }` | `{ id, lines, duration }`;`use=true` 同时用作本期字幕稿 |
| `import_video` | hybrid | `{ path?, url?, name?, set_as?: "reference"\|"cam"\|"none" }` | 桥:`path` 不在 `public/_media/` 下就复制进去(同名加时间戳),得到 `url`;再转浏览器 `register_video({ url, name, set_as, durationSec })` → `{ id, url }` |
| `seek` | browser | `{ t }` | `{ ok:true }` |
| `set_playing` | browser | `{ playing:boolean }` | `{ ok:true }` |
| `create_preset` | browser | `{ name, kind, params, description? }` | `{ id }`;kind 不存在 → error |
| `remove_preset` | browser | `{ id }` | `{ ok:true }` |
| `transcribe_video` | server | `{ path?, url?, language?:string }` | `{ srt_text, engine, seconds, lines }`;没有引擎 → error 带 hint(见 3.4) |
| `probe_media` | server | `{ path?, url? }` | `{ durationSec, sizeBytes, path, url? }` |
| `get_card_authoring_guide` | server | `{}` | `{ markdown }` = `server/card-authoring-guide.md` 全文(P4 写这份文件;P1 只负责读它,文件不在就回「指南缺失」) |

浏览器端工具名到编辑台的分发由 P3 的 `mcpExecutor` 做(§5.3),桥只转发 `{ tool, args }`。`register_video` 是内部工具(不出现在 tools/list 里)。

### 3.4 `server/stt.mjs` —— 语音识别(可插拔)

- `probeDuration(file)`:`ffprobe -v error -show_entries format=duration -of csv=p=0`(ffprobe 和 ffmpeg 同目录);`extractWav(file, outWav)`:`ffmpeg -y -i in -vn -ac 1 -ar 16000 -f wav out`。
- 引擎选择(`detectEngine()`,结果缓存):
  1. 环境变量 `OVERLAY_STT_CMD`(模板,含 `{wav}` `{srt}` `{lang}` 占位,例:`python -m faster_whisper_cli {wav} …`)→ engine `custom`;
  2. `%LOCALAPPDATA%\overlay-studio\stt.json` 里的 `{ "cmd": "…" }`(同上模板);
  3. 自动探测 `faster-whisper`:依次试 `%USERPROFILE%\anaconda3\envs\cuda_Vit\python.exe`、`python` → `-c "import faster_whisper"` 成功就用内置脚本 `server/stt-faster-whisper.py`(P1 写:读 wav,`WhisperModel("large-v3" 或环境变量 OVERLAY_STT_MODEL, device="cuda" 失败退 "cpu")`,输出 SRT 到 `{srt}`)→ engine `faster-whisper`;
  4. 都没有 → `{ available:false, hint:"这台机器没有语音识别引擎。装一个:在 conda 环境 cuda_Vit 里 pip install faster-whisper(显卡 RTX 3080 可用 CUDA);或设置环境变量 OVERLAY_STT_CMD 指向任意能把 wav 转成 srt 的命令。" }`。
- `transcribe(file, language)` → `{ srt_text, engine, seconds, lines }`;临时 wav 放 `%TEMP%\overlay-studio\stt\`,做完删。**当前机器实测没有任何 whisper**(五个 conda 环境都查过;cuda_Vit 有 torch),所以 P1 只需保证第 4 种情况的报错清楚、第 1–3 种的代码路径用一个假引擎脚本(`server/test/fake-stt.cmd`,把固定 SRT 写到 `{srt}`)走通。

### 3.5 `server/ai-system-prompt.md`

写给 AI 的说明(中文,≤ 60 行):Overlay Studio 是给口播视频加动效叠层的编辑器;时间轴上有多条序列(轨道),每张卡有 kind / start / end / track / params;素材库有视频素材、字幕素材、预设;你通过名为 `overlay-studio` 的 MCP 服务的工具读写编辑台;做事顺序(先 `get_editor_state` 了解现状;建卡前 `list_effects` 选 kind,不许编 kind;想做新样式先 `get_card_authoring_guide`,再 `create_preset`;用户要字幕就 `transcribe_video` → `import_srt(use=true)`;时间单位秒;操作完成后一句话汇报做了什么,别长篇);附件块的格式说明;编辑台未连接时该说什么;回答用用户的语言。

### 3.6 `server/vite.ai.config.ts`(只给本轮测试用)

```ts
import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config'
import { aiBridge } from './ai-bridge'
export default mergeConfig(base, defineConfig({ plugins: [aiBridge()], server: { port: 5196, strictPort: true, open: false } }))
```
启动:`npx vite --config server/vite.ai.config.ts`。P1 用它 + `server/test/fake-editor.mjs`(一个 Node 脚本:连 `/api/mcp/events`,对 `call` 事件按内存里的假编排回结果)跑通 `mcp-smoke`;P5 集成时用它跑真页面。注意 `base` 里已有 `server.open: true`,这里必须覆盖成 `false`。

### 3.7 P1 验收

`node --check` 全部通过;`mcp-smoke` 通过(initialize / tools/list 全部工具 / tools/call get_editor_state 经假编辑台回包 / 编辑台不在线时的错误文本);`/api/ai/chat` 用假 runner 能流出 run → text → done;`/api/ai/abort` 能中断;`transcribe_video` 在假引擎下得到 SRT、在无引擎下得到 hint。`server/README.md` 写清端点、事件、锁文件、STT 配置。5198 测完杀进程。

## 4. P2 · CLI 运行器(文件归属:`server/runners/index.mjs`、`server/runners/claude.mjs`、`server/runners/agy.mjs`、`server/runners/codex.mjs`、`server/runners/README.md`、`server/test/runner-smoke.mjs`)

### 4.1 接口(桥只认这个)

```js
// index.mjs
export async function listProviders(): Promise<Array<{ id:"claude"|"agy"|"codex", label:string, available:boolean, version?:string, path?:string, note?:string }>>
export function startRun(opts: {
  provider: "claude"|"agy"|"codex",
  prompt: string,            // 最终用户消息(桥已拼好附件块)
  systemPrompt: string,      // 有 --append-system-prompt 就用,否则 runner 自己拼到 prompt 前面
  sessionId?: string,        // 上一轮返回的会话 id,续聊
  cwd: string,               // 工作目录(桥保证存在)
  model?: string,
  mcp: { serverName: "overlay-studio", command: string, args: string[], env: Record<string,string> },  // command = node 的绝对路径,args = [mcp-server.mjs 绝对路径]
  onEvent: (ev: RunEvent) => void,
}): { abort(): void, done: Promise<void> }
```

`RunEvent`(规范化,三家 CLI 都要转成这几种):
`{type:"session", sessionId}` · `{type:"text", delta}`(增量正文)· `{type:"tool_call", name, input}` · `{type:"tool_result", name, ok, summary}` · `{type:"status", text}`(启动 / 注册 MCP / 等待等人话)· `{type:"done", sessionId?, usage?}` · `{type:"error", message}`。stderr 不当错误,超过 2KB 截断后作 `status` 事件转出;进程非 0 退出且没发过 done → `error`。

**统一用 `child_process.spawn(cmd, args, { cwd, env, windowsHide:true, shell:false })`**,参数走数组不走 shell(Windows 引号问题);prompt 能走 stdin 的就走 stdin。Windows 下先用 `where.exe` 解析真实可执行文件(`claude` 可能是 `.cmd`/`.exe` 垫片,`.cmd` 只能用 `shell:true` 或 `cmd.exe /c` 起,要实测)。

### 4.2 Claude Code(`claude`,2.1.221)

`claude -p --output-format stream-json --verbose --include-partial-messages --mcp-config <tmp.json> --strict-mcp-config --allowedTools <允许模式> --permission-mode default --append-system-prompt <systemPrompt> [--resume <sessionId>] [--model <m>]`,prompt 从 stdin 喂(不带位置参数)。
- `<tmp.json>` = `{ "mcpServers": { "overlay-studio": { "command": …, "args": […], "env": {…} } } }` 写到 `%TEMP%\overlay-studio\mcp-claude.json`。
- `--strict-mcp-config` 必须带:否则用户全局配置里的私人 MCP 服务(邮箱、日历等)会一起暴露给这个对话。
- `<允许模式>`:先试 `mcp__overlay-studio`(整个服务),不行再试 `mcp__overlay-studio__*`;实测哪种能让工具不弹审批就用哪种,写进 README。除此之外不给任何工具(Bash / Edit / Read 都不给;`-p` 模式下未允许的工具会被自动拒绝,不会卡住)。
- 解析 NDJSON:`{"type":"system","subtype":"init","session_id"}` → session;`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text"}}}` → text;`{"type":"assistant","message":{"content":[{"type":"tool_use","name","input"}]}}` → tool_call;`{"type":"user","message":{"content":[{"type":"tool_result","is_error"}]}}` → tool_result;`{"type":"result","subtype","session_id","is_error","total_cost_usd"}` → done / error。用了 `--include-partial-messages` 后 `assistant` 整条消息也会来,**正文只取 delta,别重复输出**。

### 4.3 Antigravity(`agy`,1.1.27)

- MCP 只能全局注册:`agy mcp add -e OVERLAY_STUDIO_PORT=<port> overlay-studio <node绝对路径> <mcp-server.mjs绝对路径>`(「add or update」,幂等)。runner 在每个 bridge 进程里第一次用 agy 时执行一次(`agy mcp list` 里已有且端口一致就跳过),发 `status` 事件「已把 Overlay Studio 注册为 agy 的 MCP 服务」。**不删别的服务**;README 里写清用户怎么手动移除(`agy mcp remove overlay-studio`)。
- 运行:`agy -p <prompt> --output-format stream-json --add-dir <cwd> --print-timeout 20m [--conversation <sessionId>] [--model <m>]`;prompt 走位置参数(数组传参,不经 shell,所以引号安全)。会话 id 从流里拿(参考 `%USERPROFILE%\.claude\skills\subagent-agy\scripts\agy-run.ps1` 里怎么解析 stream-json,那里已经做过一遍)。
- **权限**:无头默认 `request-review`,需审批的操作自动拒绝并在错误里给出建议的规则格式。要实测 MCP 工具调用会不会被拒;会被拒就把**精确到我们这个服务**的允许规则格式写进报告(`~\.gemini\antigravity-cli\settings.json` 的 `permissions.allow`),**不要自己加通配规则,也不要用 --dangerously-skip-permissions**;runner 里遇到拒绝就发 `error` 事件把 agy 的原话转给用户。
- 顺带实测一件事(结果写报告,不影响交付):`agy -p "@<某个短视频绝对路径> 这段视频里说了什么"` 能不能直接理解视频/音频(Gemini 系模型有多模态能力);能,就是流程 A 在没有本地 whisper 时的备选路径。测试视频用 `public/_media/` 里现有的那个,或用 ffmpeg 从它裁 10 秒。

### 4.4 Codex(`codex`,0.136.0)

`codex exec --json --skip-git-repo-check -C <cwd> -s read-only -c mcp_servers.overlay_studio.command="<node>" -c 'mcp_servers.overlay_studio.args=["<mcp-server.mjs>"]' -c 'mcp_servers.overlay_studio.env={OVERLAY_STUDIO_PORT="<port>"}' [-m <model>] -`(`-` = prompt 从 stdin 读)。续聊:`codex exec resume <threadId> --json … -`(看 `codex exec resume --help` 确认参数位置)。
- 事件 JSONL:`thread.started{thread_id}` → session;`item.*` 里 `agent_message` 的文本 → text(注意 `item.updated` 可能重复,只在 `item.completed` 或按增量去重);`mcp_tool_call` → tool_call / tool_result;`turn.completed{usage}` → done;`error` → error。字段名以实测为准,写进 README。
- 用户的 codex 配好了第三方 provider 和 `notify` 钩子,**别覆盖这些**(只用 `-c mcp_servers.…` 这一组覆盖),也别把配置文件内容写进日志或报告。

### 4.5 P2 验收

`server/test/runner-smoke.mjs <provider>`:用 P1 的假 MCP 服务(P1 没好之前自己写个 20 行的 stdio 假服务,只回 `get_editor_state` 固定 JSON)跑一句「调用 get_editor_state 然后用一句话告诉我时间轴上有几张卡」,三家都要拿到:session 事件、至少一条 text、一条 tool_call + tool_result、done;再用拿到的 sessionId 续聊一句「刚才那几张卡叫什么」验证会话延续;`abort()` 在 2 秒内结束进程。`listProviders()` 三家都 `available:true` 并带版本号。README 写:每家的命令行、事件字段、已知限制(agy 的全局注册、权限规则)。这些测试会真的消耗三家账号的额度,提示词保持最短。

## 5. P3 · 前端聊天面板 + 编辑台侧 MCP 执行器(文件归属:`src/components/AiPanel.tsx`、`src/components/AiPanel.css`、`src/ai/useAiChat.ts`、`src/ai/mcpExecutor.ts`、`src/ai/types.ts`、`src/ai/AiDevHarness.tsx`、`src/main.tsx` 只加一条 `?aidev=1` 路由)

### 5.1 `src/ai/types.ts`

`AiProvider = "claude"|"agy"|"codex"`;`ProviderInfo`(同 §4.1)+ `SttInfo`;`RunEvent`(同 §4.1)+ 桥的 `run/done/error`;`ChatAttachment { url:string; name:string; kind:"video"|"srt"|"json"|"other"; text?:string; durationSec?:number }`;`ChatMessage { id; role:"user"|"assistant"; text; attachments?; tools?: { name; input?; ok?; summary? }[]; error?; pending? }`。

### 5.2 `src/ai/useAiChat.ts`

`useAiChat(): { messages, providers, provider, setProvider, sessionIds: Partial<Record<AiProvider,string>>, streaming, send(text, attachments), abort(), newChat(), error }`。
- 挂载时 `GET /api/ai/providers`;`provider` 默认取第一个 `available` 的,记 localStorage `aiProvider`。
- `send`:追加 user 消息 + 一条 `pending` 的 assistant 消息;`fetch('/api/ai/chat', {method:'POST', body})`,用 `res.body.getReader()` 逐块解析 SSE(`data:` 行;跨块要拼缓冲);`text` 事件追加到 assistant 文本,`tool_call/tool_result` 进 `tools[]`,`session` 存 sessionIds[provider],`done` 收尾,`error` 标红。`AbortController` 供 `abort()`,同时 `POST /api/ai/abort {runId}`。
- 会话记录存 localStorage `aiChat:<provider>`(最近 50 条),`newChat()` 清本 provider 的记录和 sessionId。

### 5.3 `src/ai/mcpExecutor.ts` —— 编辑台侧的工具执行

```ts
export interface EditorApi {
  getState(): EditorStateForAi;                    // §3.3 get_editor_state 的结果(不含 presets / assets 也行,executor 自己补)
  getCard(id: string): OverlayCard | undefined;
  addCard(a: { kind; start; end?; track?; params? }): { id; start; end; track };   // 冲突就 throw Error("序列 2 在 3.0–8.0 秒已被 card-4(PunchPill)占用")
  updateCard(p: { id; start?; end?; track?; params? }): void;
  removeCard(id: string): void;
  importSrt(name: string, lines: SrtLine[], use: boolean): { id: string };       // 登记 addSrtAsset,use 时 applySrtLines
  registerVideo(a: { url; name?; setAs?: "reference"|"cam"|"none"; durationSec? }): { id; url };
  seek(t: number): void;
  setPlaying(b: boolean): void;
}
export function connectMcpExecutor(getApi: () => EditorApi, onStatus?: (s: { connected: boolean }) => void): () => void;  // 返回断开函数
```
- 用 `EventSource('/api/mcp/events')`;收 `call` → 按 `tool` 分发:`list_effects` 直接读 `EFFECT_GROUPS`(`src/effects/registry.ts`)组装;`import_srt` 用 `parseSrt`(`src/overlay/srt.ts`)解析后调 `api.importSrt`;`create_preset / remove_preset` 走 P4 的 `src/overlay/presets.ts`(P4 没好之前按 §6.2 的签名先写调用;P3 **不要自己建这个文件**,编译等 P4 —— 若要独立验证 tsc,可以临时在报告里说明该文件缺失导致的那一条错误);其余一一对应 EditorApi。执行结果 `POST /api/mcp/result {id, ok, result|error}`;抛错 → `ok:false, error: e.message`。未知工具 → error。
- 纯函数单独成文件方便测试:`src/ai/sse.ts`(`parseSseChunks(buffer, chunk) → { events, rest }`)、`src/ai/liteMarkdown.tsx`(`renderLiteMarkdown(text) → ReactNode`,只认段落 / **粗体** / 行内代码 / ``` 代码块 / `- ` 列表)。`npx tsx` 可直接跑 `.ts` 做单测(`src/ai/__tests__/sse.test.ts`,用 `node:assert`)。
- `replaced` / 断线:`onStatus({connected:false})`,断线 3 秒后重连(EventSource 自带重连,`replaced` 时主动 close 不重连,并提示「另一个编辑台页面接管了 AI 连接」)。

### 5.4 `src/components/AiPanel.tsx` + `.css`

`export function AiPanel(props: { mcpConnected: boolean; hotkeysOff?: boolean })`,根节点 `<aside className="panel panel-right ai-panel">`(替代原来 ParamsPanel 占的右栏;宽 340px 由 App.css 决定,面板内部自适应,**任何子元素不许撑宽**:`min-width:0`、长字符串 `overflow-wrap:anywhere`)。
- 头部:`.panel-title` 风格的「AI 助手」+ 右侧 provider `<select>`(不可用的选项 disabled,title 写「未安装」;三家标签:Claude Code / Antigravity / Codex)+ 「新对话」按钮 + 一个小圆点表示 `mcpConnected`(绿 = 编辑台已连上 MCP 桥,灰 = 未连)。
- 消息区:可滚动,user 右对齐气泡、assistant 左对齐;assistant 正文做**轻量 Markdown**(段落、`**粗体**`、行内代码、``` 代码块、`- ` 列表;不引库);工具调用渲染成一行小芯片「🔧 add_card ✓」,可点开看 input JSON;错误红字;流式时末尾一个闪烁光标;新内容到来自动滚到底(用户往上翻了就不打断,和聊天软件一致)。
- 输入区:`+` 按钮(`<input type=file accept="video/*,.srt,.json">`,视频走 `importVideoFile`(`src/library/assets.ts`,会落盘并登记),`.srt` 走 `importSrtFile` 并把原文放进附件 `text`;上传中显示进度/失败提示条);附件芯片(可移除);`<textarea>` 自动长高(最多 6 行),Enter 发送、Shift+Enter 换行;发送 / 流式时变「停止」。`hotkeysOff` 为 true 时不抢快捷键(素材库浮层开着)。
- 空状态:三条示例可点(填进输入框):「时间轴上现在有什么?」「把 3 到 8 秒做一张金句卡,文字是……」「根据我刚导入的视频做字幕」。
- 无可用 provider:面板中央提示「没找到 Claude Code / agy / Codex,装好任意一个后重启本地服务」。

### 5.5 `src/ai/AiDevHarness.tsx`(路由由 P5 加)

`export function AiDevHarness()`:左边一个假编辑台(内存里的 `OverlayDoc`,几张示例卡,表格显示 cards / srt / presets,变化就重画),右边 `<AiPanel/>`;假编辑台用 `connectMcpExecutor` 连真桥。`location.search` 里有 `mock=1` 时 `useAiChat` 用内置假流(不打后端)——只为在没有 P1 的情况下调 UI。**`src/main.tsx` 此刻归 fork2,P3 不动它**;P5 之后加 `?aidev=1` → `<AiDevHarness/>` 的路由。

### 5.6 P3 验收

tsc(自己文件)/ lint 干净;`npx tsx src/ai/__tests__/sse.test.ts` 通过(跨块拼接、多事件一块、`: ping` 注释行忽略);liteMarkdown 的几种输入有对应节点(同样 tsx 单测);AiPanel 的 CSS 走读确认没有会撑宽的东西(`min-width:0`、`overflow-wrap:anywhere`、代码块 `overflow-x:auto`)。浏览器实测(mock 流、附件芯片、300px 不溢出)留给 P5 加完路由后做。

## 6. P4 · 自定义卡 + 预设 + 写卡指南(文件归属:`src/effects/hud/CustomCard.tsx`、`src/effects/registry.ts`(只加 import 和一行注册)、`src/overlay/presets.ts`、`server/card-authoring-guide.md`、`src/overlay/__tests__/presets.test.ts` 和 `src/effects/hud/__tests__/customCardSanitize.test.ts`(可选);**`src/library/**` 一个字不碰**,素材库里的「预设」组由 P5 在 fork2 交还后加进 `LibraryTab.tsx`,见 §6.4)

### 6.1 `custom-card` 效果(`src/effects/hud/CustomCard.tsx`)

参照 `src/effects/hud/PunchPill.tsx` 的结构(`EffectDef`、`useEnter(playToken)`、`hud hud-anchor hud-anchor--<position>`、`ACCENT_OPTIONS / ACCENT_VAR / OFFSET_CONTROLS / offsetVars / THEME_OPTIONS` 来自 `./accent`)。

```ts
export interface CustomCardParams {
  theme: "dark"|"light"; position: "bottom"|"top-left"|"top-right"|"left"|"right"|"top"|"center";
  title: string; body: string;            // 文案槽,模板里用 {{title}} {{body}} 引用(会做 HTML 转义)
  html: string;                           // 卡片内部结构(受限 HTML);空 = 默认模板(标题 + 正文)
  css: string;                            // 只作用于这张卡(Shadow DOM);可写 @keyframes
  enter: "fade"|"rise"|"pop"|"none";      // 进场方式(宿主上加 .cc-enter-<enter>,配合 is-in)
  accent: string; offsetX?: number; offsetY?: number;
}
```
- 渲染:宿主 `<div className="hud cc hud-anchor hud-anchor--… is-in?" style={--hud-acc,…offsetVars}>` 里放一个 `<div ref>`,`useEffect` 里 `attachShadow({mode:"open"})`(只一次),每次 params/playToken 变就重写 `shadowRoot.innerHTML = "<style>:host{display:block}" + sanitizeCss(css) + "</style>" + render(html)`。CSS 自定义属性(`--hud-acc`、`--hud-ink` 等)能穿透 Shadow DOM,指南里告诉 AI 用它们。
- `render(html)`:替换 `{{title}} {{body}} {{accent}}`(前两者 HTML 转义),然后 `sanitizeHtml`:白名单标签 `div span p b i em strong u s small sup sub br hr h1-h4 ul ol li blockquote code pre img svg path circle rect line g text`;属性只留 `class style src alt viewBox d cx cy r x y x1 y1 x2 y2 width height fill stroke stroke-width`;去掉所有 `on*`、`javascript:`;`img src` 只允许 `/_media/…`、`/` 开头的站内路径和 `data:image/`。`sanitizeCss`:去掉 `@import`、`expression(`、`url(` 里非站内非 data: 的地址。用 `DOMParser` 做,不手写正则解析 HTML。
- 默认参数(`defaults`)要是通用示例文案(别写具体日期期号,`npm run check:defaults` 会拦):`title:"自定义卡"`,`body:"用 HTML + CSS 写你想要的样子"`,`html:""`,`css:""`,`enter:"rise"`,`position:"bottom"`,`accent:"blue"`。
- `controls`:theme、position、title(text)、body(textarea)、html(textarea,`help` 写一段语法速查:可用标签、占位符、Shadow DOM)、css(textarea,help 写可用变量)、enter(select)、accent、`...OFFSET_CONTROLS`。
- 注册:`src/effects/registry.ts` 加 `import { customCardDef } from "./hud/CustomCard";` 并加进 `信息结构` 组末尾(这个文件头上写着「自动生成」,但仓库里没有生成它的脚本,手改即可)。然后 `npm run check:cards`:`check-card-defaults` 要 `-- --accept` 登记新卡(看一眼默认值是通用的再 accept);`sync-skill-cards --check` / `sync-agent-skills --check` 不过就跑 `npm run sync:cards`,把它改了哪些文件写进报告(它会写仓库根 `.claude/skills/**/SKILL.md`)。
- 导出也走同一份组件(无头 Chrome 渲染 Shadow DOM 没问题),不需要额外处理。

### 6.2 `src/overlay/presets.ts`

```ts
export interface CardPreset { id: string; name: string; description?: string; kind: string; params: Record<string, unknown>; createdAt: string; source: "ai"|"user" }
export function listPresets(): CardPreset[];
export function addPreset(p: Omit<CardPreset, "id"|"createdAt">): CardPreset;   // 同名覆盖
export function removePreset(id: string): void;
/** 预设表变了就回调;返回取消订阅函数(本页写入 + 别的标签页的 storage 事件都触发) */
export function subscribePresets(cb: () => void): () => void;
```
localStorage 键 `overlayStudioPresets`;通知机制照 `src/library/assets.ts` 里 `subscribeAssets` 的写法(模块级 `Set<() => void>` + `window` 的 `storage` 事件),**不用 bus**。把 sanitize 之类的纯函数抽出来方便单测(`npx tsx` 能直接跑 `.ts`;DOM 相关的用 `typeof DOMParser === "undefined"` 时跳过)。

### 6.3 `server/card-authoring-guide.md`(给 AI 读的,中文,≤ 150 行)

内容:① 先看现有卡够不够(`list_effects`,常用 kind 举例:punch-pill 金句、term-card 术语、checklist 清单、ring-metric 指标…),够用就用现有 kind + params 建预设,不要什么都自定义;② `custom-card` 的参数表和限制(白名单标签、占位符、Shadow DOM 隔离、站内图片路径);③ 舞台:1920×1080,`position` 各锚点在哪(`hud-anchor--*`,边距 120/96px),安全区、别盖住人物(人物一般在画面中央偏下);④ 风格:用 `var(--hud-acc)`(强调色)、`var(--hud-ink)`(主文字)、`var(--hud-ink-2)`、`var(--hud-bg)` 之类 hud.css 里实际存在的变量(P4 查 `src/effects/hud/hud.css` 列出真实名字);字体继承,不要 @import 字体;⑤ 动效:进场靳 `enter` 选项,自定义动画写 `@keyframes` + 在 `.is-in` 后代上启用(宿主进场类是 `is-in`,Shadow 里可用 `:host(.is-in) .x {…}`);时长建议 0.4–0.8 秒,`cubic-bezier(0.22,1,0.36,1)`;⑥ 一个完整示例(params JSON);⑦ 最后一步 `create_preset({ name, kind:"custom-card", params, description })`,名字要能一眼认出用途。

### 6.4 素材库「预设」组(P5 做,等 fork2 交还 `src/library/LibraryTab.tsx` 后;写在这里是让 P4 的 API 够用)

`LibraryTab.tsx` 的左栏列表在「视频素材」「字幕素材」之外加一组「预设」:`listPresets()` 每项一行(名字、kind 的中文名 `EFFECTS.find(...)?.name`、来源标记 AI/手动、✕ 删登记),`subscribePresets` 刷新;`LibrarySelection` 加 `{ type: "preset"; id }`;选中预设时底部动作栏「＋ 加到 序列n」→ 新回调 `onAddPreset(kind, params)`(App 里 `insertCard(kind, t, track, { params })`);悬停预览 `HoverPreview` 对 preset 用 `params: preset.params` 渲染。kind 已不存在的预设灰显并提示「这张卡这一版没有」。拖到时间轴本轮不做。

### 6.5 P4 验收

tsc(自己文件)/ lint 干净;`npm run check:cards` 通过(或报告里说清跑了哪些 sync);sanitize 单测:含 `<script>` / `onclick` / `javascript:` / 外链 `<img>` / `@import` 的输入被清掉,白名单标签与属性保留;presets 单测:add(同名覆盖)/ list / remove / subscribe 回调。浏览器实测(在 5199 的页面里找到 CustomCard、改 html/css 预览实时变)能做就做,5199 白屏就留给 P5。

## 7. P5 · 主 Agent 接线(「界面」已交还 App.tsx / ParamsPanel.tsx;等 fork2 交还 App.tsx / Sidebar.tsx / TopBar.tsx / main.tsx / src/library/*;「工程目标分析」已放行 vite.config.ts)

0. `src/main.tsx` 加 `?aidev=1` → `<AiDevHarness/>` 路由;`src/library/LibraryTab.tsx` 加「预设」组(§6.4)。
1. `vite.config.ts`:`import { aiBridge } from './server/ai-bridge'`,`plugins` 加 `aiBridge()`。「工程目标分析」的要求:只在 `server/ai-bridge.ts` 已存在且 Node 22 能直接加载时提交这一行;不动它在 `overlayExport` 里的 `spawn(process.execPath, …)` 和 `reviewLog` 的 `OVERLAY_EXPORT_DIR` 两处。
2. `src/components/ParamsPanel.tsx`:新 prop `embedded?: boolean`,三处 `return <aside className="panel panel-right">` 在 embedded 时改成 `<div className="pp-embedded">`,其余不变。
3. `src/components/Sidebar.tsx`:新 prop `bottom?: ReactNode`;`.fx-list` 之后渲染拖拽分隔条 `.side-split`(上下拖,localStorage `sideBottomH`,默认 46%,范围 25%–70%)和 `.side-bottom`(放 bottom)。
4. `src/App.css`:`.panel-left` 去掉底部大 padding,`.fx-list { min-height: 120px }`,加 `.side-split / .side-bottom / .pp-embedded` 样式(pp-embedded 里的 `.ctrl-list` 继续可滚);`.panel-right` 保持 340px,内容换成 AiPanel。
5. `src/App.tsx`:`<Sidebar bottom={<ParamsPanel embedded …原 props… />}>`;右栏 `<AiPanel mcpConnected={mcpConnected} hotkeysOff={libraryOpen} />`;用现有 handlers 组 `EditorApi`(`insertCard` 扩成可指定 end 的 `addCardExplicit`,含占用检查报错;`handleCardTimes / handleCardTrack / patchCardParams / handleDeleteCard / applySrtLines + addSrtAsset / addVideoAsset + applyVideoSrc + handleSetCam / seek / setPlaying`),`useEffect` 里 `connectMcpExecutor(() => apiRef.current, setStatus)`。
6. `.gitignore` 确认 `exports/` 已忽略(ai-workspace 在里面)。
7. 集成验收:§8。

## 8. 集成验收(P5)

- tsc 0、lint 无新增。
- 5196(`npx vite --config server/vite.ai.config.ts`)开编辑台:右栏 AI 助手绿点亮;`/api/mcp/status` 显示 editorConnected。
- Claude:「时间轴上现在有什么?」→ 芯片 get_editor_state,回答里有卡数;「把 3 到 8 秒做一张金句卡,文字是……」→ 时间轴出现卡;「+」选视频 → 「根据视频做字幕」→ 无引擎时 AI 转述 hint(有引擎时素材库出现字幕、时间轴出现字幕层卡);「做一张……的卡」→ 芯片 get_card_authoring_guide → create_preset → 素材库「预设」组出现,预览正常。
- agy / codex 至少各跑通 get_editor_state + add_card。
- 布局:1280 宽窗口下左栏上半列表可滚、下半参数可滚、分隔条可拖;右栏不撑破;中栏舞台/时间轴不变。

## 9. 已做的决策与假设(要告诉用户)

1. **语音识别引擎**:这台机器现在没有任何 whisper(五个 conda 环境和 PATH 都查过),`transcribe_video` 做成可插拔,没引擎时给出安装/配置提示;推荐装 `faster-whisper` 到 conda 环境 `cuda_Vit`(有 torch,RTX 3080 20GB)——**不经用户同意不装**。备选:如果 agy 能直接理解视频(4.3 里实测),流程 A 可以完全交给 Gemini。
2. **AI 的权限**:三家都只给 Overlay Studio 自己的 MCP 工具,不给 shell / 文件读写;Claude 加 `--strict-mcp-config` 避免把用户全局配置里的私人 MCP 服务暴露给这个对话;Codex 只读沙箱;agy 的权限规则按实测结果处理。
3. **agy 需要全局注册 MCP**(它没有按次传配置的参数),首次使用自动 `agy mcp add overlay-studio …`,面板里提示一句。
4. **「新的卡片形式」** = `custom-card`(HTML + CSS 在 Shadow DOM 里,白名单过滤)+ 预设(名字 + kind + params,存本机,素材库里一组「预设」)。让 AI 直接写 TSX 组件进 `src/effects/` 不在本轮(等于给 AI 任意代码执行权,而且桌面版是打包好的 JS)。
5. 预设本轮只有「加到序列 n」按钮,不能直接拖到时间轴(时间轴拖放协议只带 kind)。
6. 参数面板搬到左栏下半部分,上下用可拖分隔条;右栏整栏给 AI 助手。
7. 素材库同期被 fork2 改成左栏顶级分页(「编辑台 | 素材库」),「预设」组加进那个分页,而不是原设想的独立窗口。

---

## 10. 进度快照(2026-09-06 07:05,用户因 token 告急叫停,等指令再继续)

**已落盘、未验收**(四个 agy manager 被中途停掉,产出在盘上但没有最终报告;文件名以磁盘为准):
- P1:`server/ai-bridge.ts`、`mcp-server.mjs`、`mcp-tools.mjs`、`stt.mjs`、`stt-faster-whisper.py`、`ai-system-prompt.md`、`vite.ai.config.ts`、`README.md`、`test/{fake-editor,mcp-smoke,fake-runner,p1-verify}.mjs`、`test/fake-stt.cmd`。`node --check` 全过。P1 停掉前发现一个真 bug 未修:**Vite 只绑 `::1`**(这台机器 localhost 解析成 IPv6),而 `mcp-server.mjs` 打的是 `127.0.0.1` → MCP 永远报「没在运行」。修法二选一:`vite.ai.config.ts` 和 `vite.config.ts` 都加 `server.host: "127.0.0.1"`(桌面壳本来就用 127.0.0.1,和「工程目标分析」对一下),或 mcp-server / 锁文件改用 `localhost` 并回退双栈。
- P2:**已完成并出了终报**(manager 在我叫停前跑完了)。`server/runners/{index,claude,agy,codex}.mjs`、`README.md`(220 行:命令行、字段映射、限制、权限规则)、`test/{runner-smoke,fake-mcp-min}.mjs`。实测:**agy 7/7 PASS**(session/text/tool_call/tool_result/done/续聊/abort);agy 无头调 MCP 工具会被拒,允许规则格式是 `mcp(overlay-studio/<工具名>)` 一个工具一条,README 已列出全部 15 条;**agy 能用 `@视频路径` 直接看视频并产出带时间码的 SRT**(2–4 秒一条,较粗)——无 whisper 时流程 A 的备选路径可行。**claude 未通**:本机 `claude` CLI OAuth 过期(`Failed to authenticate: OAuth session expired`),要用户在终端跑 `claude` 重新登录后复测 `--allowedTools mcp__overlay-studio` 能否免审批(工具全名 `mcp__overlay-studio__get_editor_state` 已确认连上)。**codex 起不来**:用户的 `~/.codex/config.toml` 写了 `model_reasoning_effort = "ultra"`,本机 codex 0.136 只认 none|minimal|low|medium|high|xhigh;绕过后第三方 provider 又回 403「账号已迁移至 api.openlux.ai」——两条都是用户环境问题,runner 检测到时给可执行提示,没有偷改用户配置。P2 测试期的 agy 全局 MCP 注册和授权规则都已清理。小瑕疵:runner-smoke 的 180 秒兜底用了 `process.exitCode` 不会强杀,CI 里跑要补 `process.exit(1)`。
- P3:`src/ai/{types,sse,useAiChat,mcpExecutor}.ts`、`liteMarkdown.tsx`、`AiDevHarness.tsx`、`__tests__/{sse.test.ts,liteMarkdown.test.tsx}`、`src/components/AiPanel.{tsx,css}`。停掉时 manager 正准备发第一轮质量返工,单测未确认跑过,tsc/lint 未确认。
- P4:`src/effects/hud/{CustomCard.tsx,customCardSanitize.ts}`、`src/overlay/presets.ts`、`server/card-authoring-guide.md`、registry.ts 已加 import 和注册(在「信息结构」组)。`__tests__` 未见;`npm run check:cards` / `check:defaults --accept` / `sync:cards` 不确定跑过(看 `scripts/defaults-reviewed.json` 有没有 custom-card、`.claude/skills/**/SKILL.md` 有没有 CustomCard 一节)。停掉时 manager 正准备发第一轮质量返工。
- agy 授权规则已全部清空;可能还有 1 个孤儿 agy.exe 在跑(被停的 manager 的子进程),它若还在写文件,以磁盘最新版为准。

**未开始**:P5 全部(§7);LibraryTab「预设」组(§6.4);main.tsx 路由。fork2 也因 token 告停,`src/library/*`、App.tsx、Sidebar.tsx、TopBar.tsx、main.tsx 仍是它的半成品,**它发「改完」之前都不能动**。

**恢复顺序建议**:① 用户重登 `claude` CLI → 跑 `node server/test/runner-smoke.mjs claude`;② 修 `::1` 问题后跑 `node server/test/mcp-smoke.mjs`;③ 对 P3/P4 文件跑 tsc/lint/单测并按契约走读一遍;④ 等 fork2 交还后做 P5。入库前把本文件里的本机绝对路径(`%USERPROFILE%\…`)洗成占位。

---

# 第八轮(2026-09-06):登录 / 首启选择 / API 直连 harness

用户原话:「除了要对接 CLI(没登陆的话要弹出等于网页让用户登录)。在软件首次启动的时候检测有哪些 CLI,让用户选择(弹出窗口)。还要使用一套内置 harness,允许用户使用 API 来直接驱动 AI。我暂时选型为 https://github.com/anthropics/claude-quickstarts。但是要注意改造这套 harness 来支持其它厂商 LLM 的接入。(听说 str_replace_editor 需要适配。)」

主 Agent 的选型判断(已告知用户):claude-quickstarts 的 `agents/` 是 **Python**(`agent.py` 的 Agent 类 + `tools/base.py` 的 Tool 基类 + `utils/` 的消息历史与 MCP 连接),而本软件的后端是 Node(Vite 中间件,桌面壳 sidecar 也是 Node,没有打包 Python)。所以**照它的结构用 Node 重写一份**放在 `server/harness/`,不引入 Python 运行时,也不加 npm 依赖(Node 22 自带 fetch)。「str_replace_editor 需要适配」的原因:它在 Anthropic API 里是服务端预定义的内置工具类型(`text_editor_*`),别家模型不认识 —— 改成一个带完整 JSON Schema 的普通 function 工具就通用了(§14.4)。

## 11. 第八轮边界与归属

- 第七轮的边界(§0)继续有效:不碰 fork2 名下的 `src/App.tsx`、`Sidebar.tsx`、`TopBar.tsx`、`main.tsx`、`src/library/**`;不碰 `vite.config.ts`、`scripts/**`、`desktop/**`、`legacy/**`;不加依赖;不跑 git;失败安全;windowsHide;端口只用 5196。
- 第七轮 P1–P4 的文件现在都归主 Agent,本轮按下面重新分配。**同一文件只有一个写者**:

| 任务 | 文件 |
|---|---|
| Q1 登录探测 + 配置存储 + 桥接改动 | `server/runners/auth.mjs`(新)、`server/ai-config.mjs`(新)、`server/runners/index.mjs`(改)、`server/ai-bridge.ts`(改)、`server/mcp-server.mjs`(改:双栈回退)、`server/vite.ai.config.ts`(改:host)、`server/README.md`、`server/runners/README.md`、`server/test/auth-smoke.mjs`(新)、`server/test/mcp-smoke.mjs`(改) |
| Q2 API 直连 harness | `server/harness/**`(新)、`server/runners/api.mjs`(新)、`server/test/harness-smoke.mjs`(新)、`server/harness/README.md` |
| Q3 首启选择弹窗 + 登录引导 + 面板改动 | `src/components/AiSetupDialog.tsx/.css`(新)、`src/components/AiPanel.tsx/.css`(改)、`src/ai/useAiChat.ts`、`src/ai/types.ts`、`src/ai/AiDevHarness.tsx`(改)、`src/ai/__tests__/**` |
| P5 主 Agent | 等 fork2「改完」后:`vite.config.ts` 一行、`main.tsx` 路由、App/Sidebar/ParamsPanel/App.css 接线、`LibraryTab.tsx` 预设组 |

- Q1 和 Q2 的接缝只有两处,写死在这里:① `server/runners/api.mjs` 导出 `getApiProvider()` 和 `startRun(opts)`(和其他 runner 同形,§4.1),Q1 在 `index.mjs` 里 import 并接进 `listProviders / startRun`(文件不存在时 `listProviders` 仍要能工作:动态 import 失败就回一条 `available:false, note:"api runner 缺失"`);② 桥在 `startRun(opts)` 里**新增** `opts.callTool(name, args) → Promise<result>`(把工具名和入参交给桥现有的 `/api/mcp/call` 同一套分发:服务端工具本地做、浏览器工具转编辑台等结果;抛错 = 工具失败),CLI runner 忽略它,api runner 靠它执行工具。Q2 开发期间用 `server/test/harness-smoke.mjs` 里的假 `callTool` 顶上。
- Q1 和 Q3 的接缝是 §12 / §13 的 HTTP 形状。

## 12. 登录探测与登录引导(Q1 服务端,Q3 前端)

### 12.1 `server/runners/auth.mjs`

`export async function probeAuth(providerId, { refresh } = {}): Promise<{ loggedIn: boolean | null; detail?: string; fixHint?: string; loginCommand?: string[] }>`,结果缓存 10 秒(`refresh` 跳过缓存)。

- **claude**:`claude auth status` 实测输出 JSON `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}` → 直接取 `loggedIn`;`loginCommand: ["claude", "auth", "login"]`(会自己打开浏览器)。
- **codex**:`codex login status`;按 stdout / exit code 判「Logged in / Not logged in」。**本机实测它先在加载 `~/.codex/config.toml` 时就报错**:`unknown variant 'ultra', expected one of none|minimal|low|medium|high|xhigh`(第 5 行的 `model_reasoning_effort`)—— 这种情况返回 `loggedIn: null`,`detail` = 报错原文那一行,`fixHint` = 「codex 配置文件 ~/.codex/config.toml 第 N 行的 model_reasoning_effort 值本版 codex 不认,改成 high 或 xhigh 后再试」。**不许替用户改配置文件,也不许读出或打印它的其他内容**。`loginCommand: ["codex", "login"]`。
- **agy**:没有登录子命令(`agy --help` 里没有 login/auth)。manager 要查清它的登录机制(`agy help`、`agy install --help`、`~/.gemini/antigravity-cli/` 目录下有没有凭据类文件名——只看文件名,不读内容;**不许把用户登出来测**),查不到就 `loggedIn: null`,`detail: "agy 没有登录状态命令;未登录时首次运行会自己打开浏览器"`,`loginCommand: ["agy"]`。
- 任何探测命令都 `timeout: 5000`、`windowsHide: true`、失败不抛(返回 `loggedIn: null` + detail)。

### 12.2 桥的改动(`server/ai-bridge.ts`)

- `GET /api/ai/providers[?refresh=1]`:每个 provider 多一个 `auth` 字段(= probeAuth 结果);`api` provider 见 §13.3。
- `POST /api/ai/login` 体 `{ provider }` → 用**可见的**控制台窗口起登录命令(用户要在浏览器里完成 OAuth,窗口给他看进度):`spawn("cmd.exe", ["/c", "start", "Overlay Studio 登录", "cmd", "/k", ...loginCommand], { detached: true, stdio: "ignore", windowsHide: false }).unref()`(`start` 后第一个参数是窗口标题;manager 实测三家的登录命令确实会弹浏览器,或至少弹出可交互的控制台)。回 `{ ok: true, hint: "已打开登录窗口,完成后回到这里会自动刷新" }`;provider 不认识 / 没装 → 400。
- `GET /api/ai/config` / `POST /api/ai/config`:见 §13.2。
- `startRun` 传 `callTool`(§11)。
- 顺手修:两处 `catch (e)` 未用变量的 lint 警告;锁文件 `%TEMP%\overlay-studio\port.json` 多写 `host`(实际监听地址,取 `server.httpServer.address()`)。
- **`server/mcp-server.mjs` 双栈回退**(第七轮 P1 发现的真 bug:Vite 默认绑 `localhost` 在这台机器上只有 `::1`,而 mcp-server 打 `127.0.0.1` 永远连不上):打 `/api/mcp/call` 时先用锁文件里的 `host`(没有就 `127.0.0.1`),`ECONNREFUSED` 再依次试 `[::1]`、`localhost`;`server/vite.ai.config.ts` 加 `server.host: "127.0.0.1"`(桌面壳本来就用 127.0.0.1 访问)。`server/test/mcp-smoke.mjs` 在 5196 起真桥且 fake-editor 连上时要真的通过 editor-up 那组用例,不能再 SKIPPED。

### 12.3 前端(Q3)

- `useAiChat` 增加:`providers[i].auth`;`login(provider)` → `POST /api/ai/login`,然后每 3 秒 `GET /api/ai/providers?refresh=1` 最多 180 秒,`auth.loggedIn` 变 true 就停并提示「已登录」;`config` / `saveConfig(partial)`(§13.2);`setupOpen / openSetup / closeSetup`。
- `AiPanel`:头部加 ⚙(打开 `AiSetupDialog`);当前 provider `auth.loggedIn === false` 时消息区顶部出一条横幅「<label> 还没登录 → 〔去登录〕」(点了变「登录窗口已打开,等你完成…」并轮询);`loggedIn === null` 且有 `fixHint` 时横幅显示 fixHint(如 codex 配置错误);发送时 provider 未登录就先弹横幅不发。
- **首启弹窗** `AiSetupDialog`(§15)。

## 13. 配置存储与「API 直连」provider

### 13.1 `server/ai-config.mjs`(Q1)

路径 `%LOCALAPPDATA%\overlay-studio\ai.json`(环境变量 `OVERLAY_AI_CONFIG` 可覆盖,测试用);不存在 = 默认值。形状:

```json
{ "version": 1,
  "defaultProvider": "claude" | "agy" | "codex" | "api" | null,
  "api": { "vendor": "anthropic" | "openai" | "gemini", "baseUrl": "", "apiKey": "", "model": "", "maxTokens": 4096 } }
```
`readConfig()` / `writeConfig(partial)`(深合并;`apiKey` 传 `""` 或缺省 = 保持原值,传 `null` = 清空)/ `publicConfig()`(`apiKey` 换成 `{ set: boolean, last4: string }`)。**任何日志、错误信息、事件里都不许出现 apiKey 原文**。

### 13.2 端点(Q1)

`GET /api/ai/config` → `publicConfig()`;`POST /api/ai/config` 体 = partial → 写入后回 `publicConfig()`。`vendor` 只认三个值,`baseUrl` 必须是 http(s) 或空,`defaultProvider` 只认四个值或 null。

### 13.3 `api` provider(Q1 在 `index.mjs` 接入,Q2 实现)

`listProviders()` 多一项:`{ id: "api", label: "API 直连", available: apiKey 已设置, version: "<vendor>/<model>", auth: { loggedIn: apiKey 已设置, detail: 没设置时 "还没填 API Key" }, note }`。`startRun({ provider: "api", … })` → `server/runners/api.mjs`。前端 `AiProvider` 类型加 `"api"`。

## 14. `server/harness/`(Q2)—— 照 claude-quickstarts/agents 的结构用 Node 重写,多厂商

### 14.1 结构

```
server/harness/
  agent.mjs          Agent 类:构造 { provider, system, tools, maxIterations = 24, onEvent, signal },async run(userText, history) → { text, history }
  history.mjs        MessageHistory:数组 + 按估算 token(字符数 / 3)截断(保留 system 与最近若干轮;截断时 onEvent 发 status)
  providers/
    base.mjs         接口:createProvider(cfg, { fetchImpl = globalThis.fetch } = {}) → { name, async *stream(messages, tools, system, signal) }(产出统一事件,见 14.2)
    anthropic.mjs    Messages API(POST {baseUrl|https://api.anthropic.com}/v1/messages,headers anthropic-version: 2023-06-01 + x-api-key,stream: true)
    openai.mjs       Chat Completions(POST {baseUrl|https://api.openai.com}/v1/chat/completions,stream: true,tools 用 function 形状)—— 任何 OpenAI 兼容端点(DeepSeek / Qwen / Moonshot / 各类中转)都走这一份,靠 baseUrl 区分
    gemini.mjs       generateContent(POST {baseUrl|https://generativelanguage.googleapis.com}/v1beta/models/{model}:streamGenerateContent?alt=sse,header x-goog-api-key,tools 用 functionDeclarations,systemInstruction)
    mock.mjs         测试用:按脚本先发一次 tool_use 再发正文
  tools/
    index.mjs        buildTools({ callTool, workspaceDir }) → Tool[]:15 个 mcp-tools(schema 直接 import ../../mcp-tools.mjs,execute = callTool)+ think + text_editor
    think.mjs        think(thought) → "ok"(quickstart 里的 ThinkTool)
    textEditor.mjs   见 14.4
  schema.mjs         JSON Schema 清洗(Gemini 不认 $schema / additionalProperties / 某些 format;OpenAI 不开 strict)
  README.md
```

### 14.2 内部消息形状与事件

- 内部统一用 Anthropic 的消息形状做中间表示:`{ role: "user"|"assistant", content: [ {type:"text", text} | {type:"tool_use", id, name, input} | {type:"tool_result", tool_use_id, content, is_error} ] }`;三个 provider 各自负责和自家格式互转(OpenAI:assistant.tool_calls ↔ tool_use,`{role:"tool", tool_call_id, content}` ↔ tool_result;Gemini:`functionCall` / `functionResponse` parts,role `model`)。
- provider 的 `stream()` 产出:`{ type:"text_delta", text }`、`{ type:"tool_use", id, name, input }`(入参拼完整后一次给)、`{ type:"usage", input, output }`、`{ type:"stop", reason }`;HTTP 非 2xx 抛 `Error("<vendor> HTTP 401: <响应体 message 字段前 300 字>")`,**响应体里若含 key 也不得回显**(只截 message 字段)。
- Agent 循环:发请求 → 收 text_delta 就 `onEvent({type:"text", delta})` → 收到 tool_use 就 `onEvent({type:"tool_call"})`、并行执行(`Promise.all`)、`onEvent({type:"tool_result"})`、追加 tool_result 消息 → 再发,直到一轮没有 tool_use 或到 maxIterations(到顶发 status「已达工具调用上限」)。`signal`(AbortController)贯穿 fetch 和循环。

### 14.3 `server/runners/api.mjs`

`getApiProvider()`(读 ai-config;见 §13.3);`startRun(opts)`:`sessionId` 是 harness 自己的会话 id(`api-<随机>`),历史存 `%TEMP%\overlay-studio\harness-sessions\<id>.json`(续聊读回来);`opts.systemPrompt` 作 system;工具 = `buildTools({ callTool: opts.callTool, workspaceDir: opts.cwd })`;RunEvent 和其他 runner 一致(session → text/tool_call/tool_result/status → done|error);`abort()` 触发 AbortController。**apiKey 只在进程内存里从 ai-config 读**,不进事件、不进日志、不进历史文件。

### 14.4 `text_editor`(str_replace_editor 的通用化)

Anthropic 的内置文本编辑器(`type: "text_editor_20250124", name: "str_replace_editor"`)是服务端定义的 schema,别家模型不认识;这里改成普通 function 工具:

```json
{ "name": "text_editor", "description": "查看/新建/修改工作目录里的文本文件(只限 exports/ai-workspace/)",
  "input_schema": { "type": "object", "properties": {
    "command": { "type": "string", "enum": ["view", "create", "str_replace", "insert", "undo_edit"] },
    "path": { "type": "string", "description": "相对 exports/ai-workspace/ 的路径" },
    "file_text": { "type": "string" }, "old_str": { "type": "string" }, "new_str": { "type": "string" },
    "insert_line": { "type": "integer" }, "view_range": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2 }
  }, "required": ["command", "path"] } }
```
语义照 Anthropic 文档:view 带行号(目录则列文件)、create 不覆盖已有文件、str_replace 要求 old_str 唯一命中、insert 在第 N 行后插入、undo_edit 撤销上一次(每个文件一条撤销栈)。路径 `resolve` 后必须在工作目录内,否则报错。README 里写清「为什么要适配」。

### 14.5 Q2 验收

`node --check` 全过;`node server/test/harness-smoke.mjs`:用 `mock.mjs` provider + 假 `callTool`(返回固定 get_editor_state)跑一轮,拿到 session / tool_call(get_editor_state)/ tool_result / text / done;text_editor 单测(create → view → str_replace → insert → undo_edit,以及越界路径被拒);三个真 provider 的请求体构造用 dry-run 测:通过 `fetchImpl` 注入假 fetch,断言 URL / header **名**(不打印值)/ body 形状,并喂一段手写的 SSE 文本验证解析(anthropic 的 content_block_start/delta/stop + message_stop;openai 的 choices[].delta.tool_calls 分片拼装;gemini 的 candidates[].content.parts.functionCall)。**不许在任何地方写入真实 API Key**;本机没有配置文件,所以不跑真实网络调用。

## 15. 首启弹窗 `AiSetupDialog`(Q3)

```ts
export function AiSetupDialog(props: {
  open: boolean; onClose: () => void;
  providers: ProviderInfo[];            // 含 auth
  stt?: SttInfo;
  current: AiProvider | null; onChoose: (id: AiProvider) => void;
  onLogin: (id: AiProvider) => Promise<void>;
  loginState: Partial<Record<AiProvider, "idle" | "waiting" | "ok" | "timeout">>;
  config: PublicAiConfig | null; onSaveConfig: (partial: AiConfigPatch) => Promise<void>;
}): JSX.Element | null;
```
- 样式照 `src/components/ConfirmDialog.tsx/.css` 的浮层做(遮罩 + 居中卡片,Esc 关闭,`role="dialog"`),类前缀 `ais-`。
- 内容:标题「选择 AI 助手的驱动方式」;三行 CLI(Claude Code / Antigravity / Codex):安装状态(版本号或「未安装」)、登录状态(✓ 已登录 / 「未登录 → 〔登录〕」/ 灰字 detail + fixHint)、单选;第四行「API 直连」:vendor `<select>`(Anthropic / OpenAI 兼容 / Gemini)、baseUrl(可空,placeholder 写默认地址)、model(text,按 vendor 给 placeholder)、apiKey(`type="password"`,已保存时显示「已保存 ••••<last4>」和「更换」按钮;永不回显)、〔保存〕;底部〔使用所选方案〕(未登录 / 没 key 时按钮禁用并说明原因)。
- 首启逻辑(在 `useAiChat` 里):`localStorage.aiSetupDone` 不存在且 providers 已加载 → `setupOpen = true`;选定后写 `aiSetupDone = "1"`、`aiProvider = id`,并 `POST /api/ai/config { defaultProvider }`。之后从 ⚙ 再开。
- `AiDevHarness` 里也能打开弹窗;`mock=1` 时 providers / auth / config 用假数据。
- 单测:把 `src/ai/__tests__/liteMarkdown.test.tsx` 修好 —— 失败原因是 `npx tsx` 没读到 `tsconfig.app.json` 的 `jsx: react-jsx`,报 `React is not defined`;用 `npx tsx --tsconfig tsconfig.app.json <文件>` 跑,并把这条命令写进测试文件头部注释(第七轮契约说的 `npx tsx` 都按这个补齐)。

## 16. 第八轮验收(P5 时统一做)

- tsc 0(除 fork2 半成品)、lint 无新增。
- 5196 起 `server/vite.ai.config.ts`:首次打开(清掉 `aiSetupDone`)弹出选择窗;三家 CLI 状态与本机一致(claude 未登录、codex 配置错误 + fixHint、agy 按实测);点「登录」Claude Code → 弹出控制台 + 浏览器登录页(**由用户自己完成登录,主 Agent 不代做**);「API 直连」填一个假 key 保存 → 列表显示「已保存 ••••xxxx」,GET /api/ai/config 不回显原文。
- `node server/test/harness-smoke.mjs` 通过;`node server/test/mcp-smoke.mjs` 在桥开着时 editor-up 组通过(双栈修好)。
- agy 已登录的话:选 Antigravity 发「时间轴上有什么」能走通(第七轮 P2 已验证 runner)。

---

## 17. 状态(2026-09-06 10:20,第七 + 第八轮收尾;§10 的快照已过时,以本节为准)

**全部接线完成,验收通过**:
- `npx tsc -p tsconfig.app.json --noEmit` 0 错误;`npm run lint` 只剩仓库原有的 fast-refresh 类警告,server/ 与 src/ai 零警告。
- 单测:`npx tsx --tsconfig tsconfig.app.json` 跑 sse / liteMarkdown / presets / customCardSanitize 全过。
- 冒烟:`node server/test/harness-smoke.mjs`(12 例)、`node server/test/auth-smoke.mjs`、`node server/test/mcp-smoke.mjs`(自起 5196 真桥,editor-up 组通过)全部 ALL PASS。
- 端到端(5195 上 `?aidev=1` 开发页,真桥 + 假编辑台):首启弹窗 → 选 Antigravity → 发「调用 get_editor_state 后用一句话告诉我时间轴上有几张卡」→ agy 走 MCP 拿到编辑台状态,回答「共有 2 张卡片,轨道 1 的 punch-pill(1~5 秒)和轨道 2 的 term-card(2~6 秒)」。测试期间临时加的 agy 允许规则 `mcp(overlay-studio/get_editor_state)` 已删;agy 全局 MCP 注册 `overlay-studio → server/mcp-server.mjs` 是 runner 自动做的,**保留**(这是产品行为)。
- `vite.config.ts` 已注册 `aiBridge()`(工程目标分析会话放行);`server/vite.ai.config.ts` 只改端口 / host / open。

**接线明细(P5)**:App.tsx 右栏 `<AiPanel mcpConnected>`,左栏 `<Sidebar bottom={<ParamsPanel embedded …/>}>`,EditorApi 实现在 App.tsx(建卡 / 改卡带占用检查,冲突 throw 原文给 AI);Sidebar 加 `bottom` 插槽 + 可拖分隔条(localStorage `sideBottomH`);ParamsPanel 加 `embedded`;App.css 加 `.side-split / .side-bottom / .pp-embedded`;LibraryTab 加「预设」组(`LibrarySelection` 多 `preset`,`onAddPreset`),HoverPreview 加 preset 分支;main.tsx 加 `?aidev=1`。

**用户环境里要自己处理的**(代码不替用户改):
1. 本机 `claude` CLI 未登录(`claude auth status` → loggedIn:false):面板里点「登录」会弹控制台 + 浏览器登录页,自己完成。Q1 测试时弹过一次,Chrome 里可能还留着一个「Sign in - Claude」标签页。
2. `~/.codex/config.toml` 第 5 行 `model_reasoning_effort = "ultra"` 本版 codex 不认(只认 none|minimal|low|medium|high|xhigh),面板横幅会提示;第三方 provider 还回 403「账号已迁移」。
3. agy 无头调 MCP 工具要逐个工具加允许规则 `mcp(overlay-studio/<工具名>)`(15 条,见 server/runners/README.md);没加时 runner 把 agy 的拒绝原文转给用户。以后可以做一个「一键授权」按钮写这 15 条。
4. 语音识别引擎没装(见 §9.1);agy 能直接看视频出 SRT(P2 实测,2–4 秒一条)。

**未做 / 留给下一轮**:预设拖到时间轴(拖放协议只带 kind);AI 直接写 TSX 组件;api provider 的真实网络调用没测过(本机没有任何 key);harness 的 usage 是最后一轮的值不是累加;`AiPanel` 的 hooks-order 报错只在 HMR 中出现过,整页刷新后没有复现,若再见到请记下复现步骤。
