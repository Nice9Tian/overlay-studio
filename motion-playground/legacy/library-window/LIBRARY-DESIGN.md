# 素材库窗口 · 设计契约(A1 / A2 并行,L3 Rust、L4 接线随后)

仓库根 `%USERPROFILE%\Documents\overlay-studio\motion-playground`,路径相对它。
另有两个会话在并行改代码:「界面」在改 TopBar.tsx / Sidebar.tsx / ParamsPanel.tsx / App.tsx(设置迁移);「工程目标分析」在改 desktop/。
**本轮任何任务都不许碰这些文件**,只在 `src/library/` 下新建;验证只用 `npx tsc -p tsconfig.app.json --noEmit` 和 `npm run lint`;
5199 上有一个别人起的 vite,直接开 `http://127.0.0.1:5199/?library=1` 看效果,不要再起 dev server,不许占 5177。

## 目标

「效果库」升级为「素材库」:动效卡 + 视频素材(口播视频以后从这里导入)。素材库是一个**独立窗口**:

| 模式 | 什么时候 | 怎么开 | 怎么和编辑台通信 |
|---|---|---|---|
| `single`(singlepage) | 网页版默认 | 编辑台内的全屏浮层(`<LibraryWindow embedded onClose>`),和编辑台同一份 React 状态 | 直接回调 props |
| `multi`(multipage) | 桌面壳(Tauri)默认 | `window.open("/?library=1", "overlay-library")` 开第二个窗口(桌面壳把它变成 Tauri 窗口,L3 做) | `BroadcastChannel("overlay-studio")`,见 bus.ts |

窗口布局(两种模式一样):左列素材列表(搜索、标签、分组;末尾一组「视频素材」);右侧上方是预览舞台,舞台下方一条走带:**播放 / 暂停 / 停止**三个按钮 + **可拖动的时间轴**(当前秒 / 总秒);最底部一个「…」按钮,点开在右侧滑出参数面板(复用 `ParamsPanel`,效果库预览态)。

## 已经做好的基础(我写的,直接 import;签名别改)

`src/library/mode.ts`
```ts
export type LibraryMode = "single" | "multi";
/** 桌面壳注入 window.__OVERLAY_DESKTOP__ = true;URL 上 ?libmode=single|multi 可强制覆盖(调试用) */
export function libraryMode(): LibraryMode;
/** 当前页面是不是独立的素材库窗口(?library=1) */
export function isLibraryPage(): boolean;
/** 打开素材库:multi 模式 window.open 一个命名窗口并聚焦(已开着就只聚焦);single 模式交给调用方渲染浮层,返回 false */
export function openLibraryWindow(): boolean;
```

`src/library/bus.ts` —— 跨窗口消息(同源 BroadcastChannel,不支持时退回 localStorage storage 事件)
```ts
export type BusMessage =
  | { type: "add-card"; kind: string; params: Record<string, unknown>; track?: number }  // 素材库 → 编辑台:把这张卡插到当前时刻
  | { type: "set-cam"; src: string }        // 素材库 → 编辑台:设为口播视频(doc.cam)
  | { type: "set-video"; src: string }      // 素材库 → 编辑台:设为画布参考视频
  | { type: "assets-changed" }              // 任一方:素材登记表变了,重新读
  | { type: "editor-state"; trackCount: number; activeTrack: number; curT: number; trackNames?: Record<number, string> } // 编辑台 → 素材库:定期/变化时广播
  | { type: "hello"; from: "editor" | "library" } | { type: "hello-ack"; from: "editor" | "library" };
export function busSend(msg: BusMessage): void;
export function busSubscribe(handler: (msg: BusMessage) => void): () => void;  // 返回取消订阅
```

`src/library/assets.ts` —— 视频素材登记表(localStorage `overlayStudioAssets`,和编排无关,按机器存)
```ts
export interface VideoAsset { id: string; name: string; src: string; addedAt: string; sizeBytes?: number; durationSec?: number }
export function listVideoAssets(): VideoAsset[];
export function addVideoAsset(a: Omit<VideoAsset, "id" | "addedAt">): VideoAsset;   // 同 src 去重
export function removeVideoAsset(id: string): void;
/** 上传一个视频文件到 public/_media(走现有 /api/media,和编辑台「导入视频」同一条路),成功后登记并返回 asset */
export function importVideoFile(file: File): Promise<VideoAsset>;
```

`src/main.tsx` 已加路由:`?library=1` → `<LibraryWindow />`(独立窗口态);其余不变。

## A1:预览器 `src/library/LibraryPreview.tsx` + `LibraryPreview.css`

```ts
interface LibraryPreviewProps {
  /** 预览什么:动效卡(effect + params)或视频素材(video src);二选一 */
  effect?: EffectDef<any>;
  params?: Record<string, unknown>;
  videoSrc?: string;
  /** 舞台外观(和编辑台一致,没有就用默认) */
  theme?: "dark" | "light"; skin?: string; docStyle?: string; font?: string; glow?: boolean;
}
```

1. **舞台**:动效卡用现有的 `<Canvas>`(src/components/Canvas.tsx)渲染 —— 它在 `overlayCards={null}` 时就是效果库预览态,传 `effect / params / playToken / showGuides={false} / showPerson={true} / videoUrl={null} / fxScale={1}` 和主题 props 即可,别复制它的舞台缩放代码。视频素材用一个 `<video>`(`playsInline`,不自动播放,宽高比按 16:9 舞台)。
2. **走带**(`.lp-transport`):「▶ 播放」「⏸ 暂停」「⏹ 停止」三个按钮 + 一条 `<input type="range">` 时间轴(左边当前秒、右边总秒,格式 `m:ss.s`)。
3. **时钟**(动效卡的核心,做对了才有「可拖动的时间轴」):
   - 动效里的 rAF 钩子读 `window.__fxExportMs`(见 src/effects/useAnimation.ts 的 clockNow):它是数字就按它算时间。预览器挂载期间**接管**这个值:播放 = 每帧 `__fxExportMs += dt × 1000`;暂停 = 不再推进;停止 = 归 0 并 `playToken + 1`(卡片重新进场);拖时间轴 = 直接把它设成 `t × 1000` 并把所有 CSS 动画 `currentTime` 设成对应值。**卸载时 `delete window.__fxExportMs`**,不然编辑台的卡会被冻住。
   - CSS 动画/过渡:对舞台节点 `getAnimations({ subtree: true })`,暂停时 `pause()`,拖动时 `currentTime = 相对进场的毫秒`,播放时 `play()`;播放速率跟走带一致。
   - 总时长:动效卡没有固定时长,走带按「进场 + 8 秒」当总长(可在「…」里改预览时长,先不做);视频素材用 `video.duration`。
   - 每次 `effect / params` 变了就相当于停止再播放(和现在效果库「改参数就重放」一致)。
4. 视频素材的走带直接控制 `<video>`(play/pause/currentTime),不碰 `__fxExportMs`。
5. 导出为默认导出 `LibraryPreview`;样式只写在 LibraryPreview.css,用 App.css 已有变量。

## A2:窗口本体 `src/library/LibraryWindow.tsx` + `LibraryWindow.css`

```ts
interface LibraryWindowProps {
  /** 嵌入模式(single):作为编辑台里的全屏浮层渲染,带关闭按钮和 Esc 关闭 */
  embedded?: boolean;
  onClose?: () => void;
  /** 嵌入模式下由编辑台直接接收(multi 模式走 bus,这些不传) */
  onAddCard?: (kind: string, params: Record<string, unknown>, track?: number) => void;
  onSetCam?: (src: string) => void;
  onSetVideo?: (src: string) => void;
  /** 嵌入模式下编辑台传进来的状态;multi 模式从 bus 的 editor-state 消息里拿 */
  editorState?: { trackCount: number; activeTrack: number; curT: number; trackNames?: Record<number, string> };
}
```

1. **左列**:复用效果库的列表逻辑(分组 `EFFECT_GROUPS`、搜索、`VISUAL_TAGS` 标签筛选、↑↓ 换卡 —— 从 src/components/Sidebar.tsx 的效果库部分**照抄**到这里,不 import Sidebar);每个效果项仍 `draggable`,`dataTransfer` 用 `application/x-overlay-effect`(和时间轴的拖放契约一致)。列表末尾一组「视频素材」:`listVideoAssets()` 的每一项(名字、时长、加入时间)+ 「＋ 导入视频」按钮(`importVideoFile`,进度/失败提示)+ 每项右键或 ✕ 删除登记(不删文件)。
2. **右侧**:`<LibraryPreview>`;选中动效卡时下面一排动作按钮:「＋ 加到序列 n」(n = editorState.activeTrack,名字用 `trackLabel(n, trackNames)`;embedded 时调 `onAddCard`,multi 时 `busSend({type:"add-card", …})`);选中视频素材时:「设为口播视频」「设为画布参考视频」(同样二选一路径)。multi 模式下编辑台不在线(没收到 hello-ack / editor-state)时按钮禁用并提示「编辑台窗口没开」。
3. **「…」按钮**(窗口右下角常驻):点开在右侧滑出一栏,里面渲染 `<ParamsPanel>`(效果库预览态:`effect / params / onChange / onChangeMany`,不传 card/editMode),参数改动实时反映到预览;再点或 Esc 收起。参数状态按 kind 记在本窗口内存里(`paramsById`),初始值 = `effect.defaults`。
4. 独立窗口态(`?library=1`,`embedded` 未传):挂载时 `busSend({type:"hello", from:"library"})`,订阅 `editor-state`;标题栏写「素材库」,没有关闭按钮(窗口自己有)。嵌入态:铺满视口的浮层,右上角 ✕,Esc 关闭,底下的编辑台不可交互。
5. 样式只写在 LibraryWindow.css;色板、字体用 App.css 变量;列表项复用现有 `.fx-item` 等类名可以,别改 App.css。

## L3(Rust,等「工程目标分析」会话交接 lib.rs 后做)

`desktop/src-tauri/src/lib.rs`:主窗口 `initialization_script("window.__OVERLAY_DESKTOP__ = true")`;`on_new_window` 里 URL 主机是 `127.0.0.1` / `localhost` 时,不再丢给系统浏览器,而是:已有 label `library` 的窗口 → 聚焦;没有 → `WebviewWindowBuilder::new(app, "library", WebviewUrl::External(url))`,标题「素材库」,1280×800,同样的 on_navigation 规则,记住尺寸。BroadcastChannel 在同一个 WebView2 用户数据目录下的两个窗口之间是通的(同源),不需要 IPC。

## L4(接线,等「界面」会话交接后做)

TopBar:「效果库」页签改成「素材库」按钮 → `openLibraryWindow()`,返回 false 时 App 渲染 `<LibraryWindow embedded onClose … />`;Sidebar 里的效果库列表和 App 的 `tab === "library"` 分支删掉;App 订阅 bus:收 `add-card` 走 `insertCard(kind, start=当前时刻, track)`,收 `set-cam` 设 `doc.cam`,收 `set-video` 走现有导入视频逻辑(src 已在 /_media);编辑台状态变化时 `busSend({type:"editor-state", …})`,收到 `hello` 回 `hello-ack`;single 模式打开浮层时暂停播放。左栏/设置里原来的「口播视频」控件删掉,改为素材库导入。

## 验收(集成时统一做)

- tsc 零错误、lint 不新增。
- 网页(single):点「素材库」出浮层;选一张卡,播放/暂停/停止/拖时间轴都作用于预览;「…」打开参数面板,改参数预览跟着变;「加到序列 2」→ 编辑台时间轴当前时刻出现这张卡且在序列 2;Esc 关闭浮层,编辑台卡片动画恢复正常(`__fxExportMs` 已清掉)。
- 多窗口(multi,先用 `?libmode=multi` 在网页模拟):点「素材库」弹出新窗口;新窗口里「加到序列 n」→ 主窗口出现卡;导入一个视频 → 两边的素材列表都刷新;「设为口播视频」→ 主窗口 doc.cam 变了(自动存档里能看到)。
- 桌面壳:同上,且新窗口是 Tauri 窗口不是系统浏览器。

---

## A3:字幕素材 `src/library/LibrarySubtitles.tsx` + `LibrarySubtitles.css`(用户追加:左栏的「字幕稿」也搬进素材库)

基础已就绪(我写的,签名别改):
- `bus.ts` 新增消息:`{ type: "set-srt"; name; lines }`(用作本期字幕稿)、`{ type: "seek"; t }`(跳到某句);`editor-state` 多了 `cardSpans?: [start,end][]`(画「已有卡覆盖」圆点)和 `srtName?: string`(编辑台正在用哪份)。
- `assets.ts` 新增:`SrtAsset { id, name, lines, addedAt }`、`listSrtAssets() / addSrtAsset({name, lines}) / removeSrtAsset(id) / importSrtFile(file) / srtDuration(lines)`;登记表变化会广播 `assets-changed`。

交付两个组件(都是纯展示 + 回调,不直接碰 bus,由窗口本体决定走 props 还是 bus):

```ts
/** 左列的「字幕素材」组:列表 + 导入按钮 */
export function SubtitleAssetList(props: {
  selectedId: string | null;              // 当前选中的字幕素材 id
  onSelect: (id: string) => void;
  inUseName?: string;                     // 编辑台正在用的字幕稿名字,列表里标「使用中」
}): JSX.Element;

/** 右侧详情:选中一份字幕后显示的句子列表 + 「用作本期字幕稿」 */
export function SubtitleAssetView(props: {
  asset: SrtAsset;
  curT?: number;                          // 编辑台当前秒,用来高亮正在播的那一句
  cardSpans?: [number, number][];         // 有卡覆盖的区间,画圆点
  inUse?: boolean;                        // 就是编辑台正在用的这份
  disabled?: boolean;                     // multi 模式编辑台没连上时禁用两个动作
  onUse: (asset: SrtAsset) => void;       // 「用作本期字幕稿」
  onSeek: (t: number) => void;            // 点某一句 → 跳到 start + 0.01
}): JSX.Element;
```

1. 列表项:名字、句数、总时长(`srtDuration`,m:ss)、加入时间;✕ 删登记(不弹确认,可撤销不了但只是登记);「＋ 导入 SRT」按钮走 `importSrtFile`,失败用页内提示(不要用 alert,内嵌浏览器会吞)。订阅 `assets-changed` 刷新列表(这一点组件内部自己做,`busSubscribe` 只读不发)。
2. 详情:句子列表照抄现在 src/components/Sidebar.tsx 里字幕稿视图的样子(`.srt-line / .srt-time / .srt-dot / .srt-text` 类名可复用):时间 + 圆点(`cardSpans` 里有区间和这句相交就点亮)+ 文本;`curT` 落在哪句就高亮哪句并 `scrollIntoView({ block: "nearest" })`;点一句调 `onSeek(line.start + 0.01)`。顶部一行:名字、句数、时长,右侧按钮「用作本期字幕稿」(`inUse` 时显示「✓ 使用中」并禁用)。
3. 样式只写 LibrarySubtitles.css,用 App.css 变量。
4. 不改 LibraryWindowImpl.tsx / LibraryWindow.tsx / LibraryPreview.tsx(A2 / A1 在写);集成时由主 Agent 把这两个组件塞进窗口本体:左列多一组「字幕素材」,选中后右侧不显示预览器而显示 `SubtitleAssetView`。

接线时(L4)编辑台要做:收 `set-srt` → 走 `handleImportSrt` 的老逻辑(setSrt + 没有字幕层卡就自动生成一张),并记住 `srtName`;收 `seek` → `seek(t)`;`editor-state` 广播时带 `cardSpans` 和 `srtName`;左栏「字幕稿」页签删掉(字幕只在素材库看和点)。

---

## L4 细化(「界面」会话已交接 TopBar / Sidebar / ParamsPanel / App,以下按交接时的现状写)

现状(2026-09-06 「界面」第五轮交接):TopBar props 里有 `cam / onSetCam`(「🎨 全局风格」面板最后一行是临时的口播视频控件,上传用 `src/uploadDemo.ts` 的 `uploadDemo(file)`);
Sidebar 只剩轨道页签 / 卡片列表 / 字幕稿 / 效果库(`tab === "library"` 分支,底部「▶ 重放动画」);App 里效果库态的状态是 `tab / selectedId / paramsById / handleAddToTimeline`,
`insertCard(kind, start, track, opts?)` 是建卡入口,`seek(t)` 是跳转入口,`handleImportSrt(file)` 是字幕导入入口(setSrt + 没有 caption-track 卡就自动生成一张),`camClearedRef` 记录「用户手动清过口播视频就不再跟随导入视频」。

文件归属:L4 只改 `src/App.tsx`、`src/components/TopBar.tsx`、`src/components/Sidebar.tsx`、`src/library/LibraryWindow.tsx`(把占位换成 re-export Impl)、`src/main.tsx`(清掉 A2/A3 的临时分支);`src/library/*Impl/Preview/Subtitles` 由主 Agent 先拼好再交给 L4。

1. **入口**:TopBar 的「效果库」页签改成按钮「素材库」(不再是 tab):点击调 `openLibraryWindow()`(src/library/mode.ts);返回 false(single 模式)时通过新 prop `onOpenLibrary()` 让 App 把 `libraryOpen` 置 true 并渲染 `<LibraryWindow embedded onClose={() => setLibraryOpen(false)} …/>`,打开时 `setPlaying(false)`。`StudioTab` 类型收成只有 `"edit"`(或整个删掉 tab 状态),Sidebar 删掉 `tab === "library"` 分支和「▶ 重放动画」,App 删掉 `selectedId / paramsById / handleAddToTimeline` 及 Canvas 的效果库预览态传参(Canvas 永远 `overlayCards={activeCards}`)。ParamsPanel 的效果库预览态 props(`onAddToTimeline / addAt / addSec / addTrack`)不再由 App 传(ParamsPanel 本身保留这些可选 props,素材库窗口在用)。
2. **嵌入态回调**(single):`onAddCard(kind, params, track)` → `insertCard(kind, round(curT,0.1), track ?? activeTrack)` 但 params 用传入的(insertCard 现在从 paramsById 取,改成可传入);`onSetCam(src)` → 和 TopBar 的 onSetCam 同一段逻辑(含 camClearedRef);`onSetVideo(src)` → 新增 `applyVideoSrc(src)`:直接 `setVideoUrl(src)` 并按现有规则让 doc.cam 跟随(src 已经在 /_media,不用再上传);`onSetSrt(name, lines)` → 把 `handleImportSrt` 拆成 `applySrtLines(lines)`(setSrt + 自动字幕层卡)复用,并记 `srtName` 状态(进自动存档);`onSeek(t)` → `seek(t)`。LibraryWindowProps 相应加 `onSetSrt?` 和 `onSeek?`(契约 A2 的签名之外新增两个可选项)。
3. **bus**(multi):App 挂载时 `busSubscribe`:`hello` → `busSend({type:"hello-ack", from:"editor"})` 并立刻广播一份 editor-state;`add-card / set-cam / set-video / set-srt / seek` 走第 2 条同样的函数;`trackCount / activeTrack / curT(节流到 250ms) / trackNames / cards 区间 / srtName` 任一变化 → `busSend({type:"editor-state", …, cardSpans: cards.map(c=>[c.start,c.end]), srtName})`。
4. **口播视频**:TopBar「全局风格」里那一行删掉,props `cam / onSetCam` 从 TopBar 移除;App 的 onSetCam 逻辑保留给素材库用。`uploadDemo.ts` 保留(素材库不用它,视频素材走 /api/media;留着给 ParamsPanel 以后用)。
5. **字幕稿**:Sidebar 删掉「字幕稿」页签、`srt / onImportSrt / onSeek / curT` 相关 props;App 里拖 .srt 文件进窗口的旧入口(`handleImportSrt(f)`)改成「登记进字幕素材并用作本期字幕稿」(`addSrtAsset` + `applySrtLines`)。
6. 验收沿用「验收」一节,加:字幕素材里点一句 → 编辑台播放头跳过去;「用作本期字幕稿」→ 编辑台有了字幕稿且自动生成字幕层卡(编排里原本没有的话);multi 模式下同样成立。

---

## 进度(2026-09-06)

- A1 / A2 / A3 / L4 已完成,并在 5199 上实测:浮层(single)和独立窗口(multi,走 bus)两条路都验过 加到序列 / 设为口播视频 / 设为画布参考视频 / 用作本期字幕稿 / 点句跳转 / 播放头高亮跟随 / 「使用中」标记。
- L3(桌面壳)未做,等「工程目标分析」会话发「打包完成」后改 desktop/src-tauri/src/lib.rs:主窗口 initialization_script 注入 `window.__OVERLAY_DESKTOP__ = true`;on_new_window 遇到同源的 `?library=1` 地址改成建 / 聚焦 label 为 `library` 的 Tauri 窗口(1280×800,标题「素材库」),不再拒绝后外开;同步 desktop/DESIGN.md 第 9 条和 README。没做之前桌面壳自动落到 single 模式(浮层),功能不缺,只是没有独立窗口。
- ParamsPanel 里效果库时代的可选 props(onAddToTimeline / addAt / addSec / addTrack)现在没人传了,留给下一轮清理。
- 遗留:src/uploadDemo.ts 不再被 TopBar 引用(视频素材走 /api/media),先留着。
