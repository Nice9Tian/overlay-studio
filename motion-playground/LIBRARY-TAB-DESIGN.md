# 素材库分页(左栏顶级分页版)—— 契约

日期:2026-09-06。上一版「素材库独立窗口」已归档到 `legacy/library-window/`(含 README 和旧契约),本文是新形态的契约。

## 用户要的形态

- 左栏顶部两个**顶级分页**:「编辑台」「素材库」。编辑台分页 = 现在的左栏(轨道页签 + 卡片列表);素材库分页 = 素材左菜单。
- 素材库分页里:动效卡(搜索 / 标签 / 分组)、视频素材、字幕素材(字幕稿也搬进素材库)。
- **拖动**:把动效卡从素材库拖到时间轴的指定位置 / 指定轨道(TimelineBar 已支持 `application/x-overlay-effect` 的落卡,拖到两轨之间新建轨道)。
- **悬停预览**:鼠标停在某个素材上,旁边浮出预览(动效卡 = 动画自动进场;视频 = 静音循环小视频;字幕 = 前几句)。
- 点选素材后底部有动作按钮(加到序列 / 设为参考视频 / 设为口播视频 / 用作本期字幕稿),不用拖也能用。
- 画布永远是时间轴模式;悬停预览**不能**接管 `window.__fxExportMs`(会冻住画布上的卡)。

## 文件归属(并行三人,互不碰对方文件)

| 人 | 文件 |
|---|---|
| A | `src/library/assets.ts`(改)、`src/library/LibraryTab.tsx`(新)、`src/library/LibraryTab.css`(新) |
| B | `src/library/HoverPreview.tsx`(新)、`src/library/HoverPreview.css`(新) |
| C | `src/App.tsx`、`src/components/Sidebar.tsx`、`src/components/TopBar.tsx`、`src/main.tsx`(必要时 `.oxlintrc.json` 加 `ignorePatterns`) |

谁都不碰:`TimelineBar.*`、`Canvas.tsx`、`ParamsPanel.*`、`types.ts`、`App.css`(新样式写自己的 css 文件,可以**复用** App.css 里已有的类)。
`legacy/` 目录里的文件只读。

现状(C 接手时):`src/App.tsx` 里还留着窗口版的接线(import LibraryWindow / mode / bus、`libraryOpen`、`openLibrary`、`editorState` bus 广播、`busActionsRef` 订阅、`<LibraryWindow embedded …/>`),这些 import 的文件已经搬走,tsc 当前报错是预期的,由 C 清掉。`src/library/assets.ts` 还 import `./bus`,由 A 改掉。

## 接口契约

### A:`assets.ts`

保留现有的 `VideoAsset / listVideoAssets / addVideoAsset / removeVideoAsset / importVideoFile` 和 `SrtAsset / listSrtAssets / addSrtAsset / removeSrtAsset / importSrtFile / srtDuration`,签名不变。改动:

- 删掉 `import { busSend } from "./bus"` 和两处 `busSend({ type: "assets-changed" })`。
- 新增页内通知:

```ts
/** 登记表(视频 / 字幕)变了就回调;返回取消订阅函数 */
export function subscribeAssets(cb: () => void): () => void;
```

`write()` / `writeSrt()` 之后通知所有订阅者(模块级 `Set<() => void>` 即可);同时监听 `window` 的 `storage` 事件(key 命中两个登记表之一)也通知,别的标签页改了也能刷新。

### A:`LibraryTab.tsx`

```ts
import type { SrtLine } from "../overlay/srt";

export type LibrarySelection =
  | { type: "effect"; id: string }   // id = 特效 kind
  | { type: "video"; id: string }    // id = VideoAsset.id
  | { type: "srt"; id: string }      // id = SrtAsset.id
  | null;

export interface LibraryTabProps {
  /** 当前轨道(「＋ 加到 序列n」的文案和目标) */
  activeTrack: number;
  trackNames?: Record<number, string>;
  /** 编辑台正在用的字幕稿名字(列表里标「使用中」) */
  srtName?: string;
  /** 编辑台播放头(展开的字幕句子高亮 + 自动滚动) */
  curT: number;
  /** 时间轴上所有卡的 [start, end](字幕句「已有卡覆盖」圆点) */
  cardSpans: [number, number][];
  /** 当前画布参考视频 src(视频项标「参考视频」);doc.cam(标「口播」) */
  videoSrc?: string | null;
  camSrc?: string;
  onAddCard: (kind: string) => void;                       // ＋ 加到 序列n(播放头处、默认参数)
  onSetVideo: (src: string) => void;                       // 设为画布参考视频
  onSetCam: (src: string) => void;                         // 设为口播视频
  onUseSrt: (name: string, lines: SrtLine[]) => void;      // 用作本期字幕稿
  onSeek: (t: number) => void;                             // 点了字幕里的某一句
  /** 悬停到某个素材(null = 移开 / 开始拖动 / 列表滚动了);anchor = 列表项的 getBoundingClientRect() */
  onHover: (item: LibrarySelection, anchor: DOMRect | null) => void;
  /** true 时接管 ↑↓(素材库分页显示时);false 时不挂键盘监听 */
  hotkeys: boolean;
}

export function LibraryTab(props: LibraryTabProps): JSX.Element;
```

行为:

1. **布局**:根元素 `.lib-tab` 撑满左栏剩余高度(flex column,`min-height: 0`),从上到下:搜索框(复用 `.fx-search` + `.ctrl-input`,placeholder 和归档版一致)、标签栏(`.fx-tagbar` / `.fx-tag`,`VISUAL_TAGS`)、可滚动列表(`.fx-list`,里面是 `.fx-group` / `.fx-group-title` / `.fx-group-count`)、底部动作栏(`.lib-foot`,`flex: none`,上边一条 hairline)。
2. **动效卡**:`EFFECT_GROUPS` 分组;过滤规则照归档版 `legacy/library-window/LibraryWindow.tsx` 的 `fxGroups`(id / name / description / tags 命中,组名命中整组保留)。每张卡是 `.fx-item`(序号 `.fx-idx`、`.fx-name` 带 `.fx-dot` 用 `kindColor(kind)`、`.fx-desc`、`.fx-tags` 里可点的标签),`draggable`,`onDragStart` 写 `dataTransfer.setData("application/x-overlay-effect", kind)`、`effectAllowed = "copy"`,拖动中加 `.is-dragging`,并且 `onHover(null, null)`;`title="拖到时间轴 = 加到那条轨道"`。没有匹配时 `.fx-empty` 提示。
3. **视频素材组**:标题「视频素材」+ 计数;「＋ 导入视频」按钮(隐藏 `<input type=file accept="video/*">` → `importVideoFile`,导入中禁用并显示「导入中…」,失败页内红字 `.lib-err`,**不弹 alert**);每条:文件名、时长(m:ss.s,探到才显示)· 加入日期;右侧 ✕ 删登记(不删文件,`stopPropagation`);和 `videoSrc` 同路径(忽略 `?v=`)的标「参考视频」小徽章,和 `camSrc` 相同的标「口播」。项是 `<div role="button" tabIndex=0>`,**不要 button 套 button**。
4. **字幕素材组**:标题「字幕素材」+ 计数;「＋ 导入 SRT」(`importSrtFile`,失败页内提示);每条:名字、`n 句 · m:ss`、加入时间;`srtName === name` 标「使用中」;✕ 删登记。**选中的那条**在它下面展开句子列表(`.lib-srt-lines`,复用 App.css 的 `.srt-line / .srt-time / .srt-dot / .srt-text`):时间 + 圆点(`cardSpans` 里有区间和这句相交就 `.is-covered`)+ 文本;`curT` 落在哪句就 `.is-now` 并 `scrollIntoView({ block: "nearest" })`;点一句 `onSeek(line.start + 0.01)`。
5. **选中**:组件内部状态 `selection: LibrarySelection`;点项选中;导入成功后自动选中新项;删掉的正好是选中的就清掉。`hotkeys` 为 true 时 ↑↓ 在「当前可见的动效卡 → 视频 → 字幕」这条扁平列表里走(输入框里的 ↑↓ 让位,搜索框例外,照归档版),选中项 `scrollIntoView({ block: "nearest" })`。
6. **底部动作栏**按选中类型:
   - 动效卡:主按钮「＋ 加到 {trackLabel(activeTrack, trackNames)}」→ `onAddCard(kind)`;旁边小字「或直接拖到时间轴的任意位置」。
   - 视频:「设为画布参考视频」(已经是就显示「✓ 参考视频」并禁用)、「设为口播视频」(已经是就「✓ 口播视频」并禁用)。
   - 字幕:「用作本期字幕稿」(`srtName === name` 时「✓ 使用中」并禁用)。
   - 没选:小字「点一个素材看操作;动效卡可以直接拖到时间轴」。
7. **悬停**:每个项 `onMouseEnter` → `onHover(该项, e.currentTarget.getBoundingClientRect())`;列表容器 `onMouseLeave` → `onHover(null, null)`;列表 `onScroll` → `onHover(null, null)`(矩形过期);`onDragStart` → `onHover(null, null)`。本组件**不渲染**预览浮窗(App 渲染 `HoverPreview`,它 portal 到 body,不受左栏 overflow 影响)。
8. **登记表刷新**:挂载时 `listVideoAssets() / listSrtAssets()`,`subscribeAssets` 变化时重读。
9. 样式只写 `LibraryTab.css`(新类前缀 `lib-`),按钮沿用 `.video-btn` 观感(见 App.css `.video-btn`),主按钮用 `var(--accent)` 底 + `var(--on-accent)` 字。

### B:`HoverPreview.tsx`

```ts
import type { LibrarySelection } from "./LibraryTab";   // 类型循环无所谓,只是 type import

export interface HoverPreviewProps {
  item: LibrarySelection;          // null = 不显示
  anchor: DOMRect | null;          // 被悬停的列表项的屏幕矩形
  /** 编辑台全局外观,让预览和画布一致(都可缺省) */
  theme?: "dark" | "light";
  skin?: string;
  docStyle?: string;
  font?: string;
  glow?: boolean;
  sideColor?: string;
  inkColor?: string;
}

export function HoverPreview(props: HoverPreviewProps): JSX.Element | null;
```

行为:

1. `createPortal` 到 `document.body`;根 `.hp-pop`,`position: fixed`,`pointer-events: none`(纯展示,永远不抢鼠标),`z-index: 900`,宽 400px;`left = anchor.right + 10`,`top = anchor.top`,再夹到视口内(`top ≥ 8`,`top + 高 ≤ innerHeight − 8`;右边放不下就放到 `anchor.left − 10 − 宽`)。高度用 `ResizeObserver` 或 `getBoundingClientRect` 量完再夹。
2. **延时显示**:`item` 变成非 null 后 220ms 才显示(定时器;期间 item 又变了就重新计时;变 null 立即隐藏、清定时器);出现时 120ms 淡入。
3. **动效卡**(`item.type === "effect"`,`EFFECTS.find(e => e.id === item.id)`,找不到 → 不显示):头部名字 + 描述 + 标签;主体 16:9 舞台盒 `.hp-stage`(`width: 100%; aspect-ratio: 16/9; position: relative; overflow: hidden; background: var(--bg-canvas)`),里面
   ```tsx
   <Canvas effect={def} params={{ ...def.defaults, theme: def.defaults.theme ?? theme ?? "dark" }}
           playToken={token} showGuides={false} showPerson videoUrl={null} fxScale={1}
           overlayCards={null} overlayTheme={theme} glow={glow} font={font} skin={skin}
           docStyle={docStyle} sideColor={sideColor} inkColor={inkColor} animSpeed={1} />
   ```
   加 css `.hp-stage > .canvas-wrap { position: absolute; inset: 0; margin: 0; }`(Canvas 自己用 ResizeObserver 把 1920×1080 缩进容器,这是归档版 `LibraryPreview.css` 验证过的写法)。`token` 每次 `item` 变化 +1,让进场动画重放。**禁止**读写 `window.__fxExportMs`。
4. **视频**(`listVideoAssets().find(...)`):同一个舞台盒里 `<video muted autoPlay loop playsInline preload="metadata" src>`(`object-fit: contain`),下面文件名 + 时长。
5. **字幕**(`listSrtAssets().find(...)`):名字、`n 句 · m:ss`,前 6 句(时间 + 文本,单行省略),多出的写「…还有 n 句」。
6. `item` 变 null → 立即卸载内容(Canvas 一起卸掉,别留后台动画)。
7. 样式只写 `HoverPreview.css`,类前缀 `hp-`,用 App.css 的变量(`--bg-elev / --hairline / --ink / --ink-muted / --font-mono` 等)。

### C:`Sidebar.tsx`

- 新 props:`tab: "edit" | "library"; onTab: (t: "edit" | "library") => void; library: LibraryTabProps`(整个对象透传)。删掉 `hotkeysOff`。
- 顶部加一行顶级分页 `.side-top`:两个 `.side-top-tab` 按钮「编辑台」「素材库」(选中 `.is-on`;样式可以写在 `SidebarTracks.css`——它是我们自己的文件),放在现有 `.side-tabs`(轨道页签)上面。
- `tab === "library"` 时渲染 `<LibraryTab {...library} hotkeys />`,不渲染轨道页签和卡片列表;`tab === "edit"` 时和现在一样,并且卡片列表的 ↑↓ 监听只在 edit 分页挂。

### C:`TopBar.tsx`

- 删掉「编辑台」「📚 素材库」两个按钮和 `onOpenLibrary` prop(入口在左栏分页)。其余不动。

### C:`App.tsx`

- 删:`LibraryWindow / LibraryEditorState / openLibraryWindow / busSend / busSubscribe` 的 import;`libraryOpen / libraryOpenRef`;`openLibrary`;`editorState` 及其 `useMemo / editorStateRef / lastBroadcastRef` 和 250ms 广播 effect;`busActionsRef` 和 `busSubscribe` effect;`<LibraryWindow embedded …/>`;全局快捷键里的 `libraryOpenRef.current` 判断;传给 Sidebar 的 `hotkeysOff`。
- 加:`import { LibraryTab 的类型 LibrarySelection }`、`import { HoverPreview } from "./library/HoverPreview"`;
  `const [sideTab, setSideTab] = useState<"edit" | "library">("edit")`;
  `const [hover, setHover] = useState<{ item: LibrarySelection; anchor: DOMRect | null }>({ item: null, anchor: null })`;
  保留 `cardSpans` 的 useMemo。
- `handleLibraryAddCard` 改成 `(kind: string) => insertCard(kind, Math.round(curTRef.current * 10) / 10, activeTrack)`(默认参数;`insertCard` 的 `opts.params` 支持留着无害)。
- `<Sidebar … tab={sideTab} onTab={setSideTab} library={{ activeTrack, trackNames: overlay?.trackNames, srtName, curT, cardSpans, videoSrc: videoUrl, camSrc: overlay?.cam, onAddCard: handleLibraryAddCard, onSetVideo: applyVideoSrc, onSetCam: handleSetCam, onUseSrt: (name, lines) => applySrtLines(lines, name), onSeek: seek, onHover: (item, anchor) => setHover({ item, anchor }) }} />`。
- 在 `.app-body` 后面渲染 `<HoverPreview item={hover.item} anchor={hover.anchor} theme={overlay?.theme} skin={overlay?.skin} docStyle={overlay?.style} font={overlay?.font} glow={overlay?.glow ?? false} sideColor={overlay?.sideColor} inkColor={overlay?.inkColor} />`。
- `applySrtLines / handleImportSrt / applyVideoSrc / handleSetCam / srtName / 自动存档` 都保持现状。
- `src/main.tsx`:删 `?library=1` 路由和 `LibraryWindow` import(只剩 export / App 两条路)。
- `npm run lint` 如果因为 `legacy/` 多出警告,在 `.oxlintrc.json` 加 `"ignorePatterns": ["legacy/**"]`。

## 验收

- `npx tsc -p tsconfig.app.json --noEmit` 0 错误;`npm run lint` 不比基线(28 条 warning)多。
- 左栏顶部「编辑台 | 素材库」;编辑台分页和改前一样(轨道页签、卡片列表、清空、空状态的「📥 导入 JSON」);顶栏不再有分页按钮。
- 素材库分页:搜索「滚动」筛出带该标签的卡;标签按钮切换;三个组都在。
- 悬停动效卡约 0.2 秒后右侧浮出预览,动画自动进场,鼠标移开立即消失,拖动时不出现,列表滚动时消失;悬停视频是静音循环小视频;悬停字幕是前几句。
- 悬停期间编辑台画布上正在播的卡**不受影响**(不冻、不跳)。
- 从素材库拖一张卡到时间轴某条轨道的某个位置 → 卡落在那里;拖到两轨之间 → 新建轨道落卡;拖动结束回到素材库分页(不自动切分页)。
- 点动效卡 → 底部「＋ 加到 序列n」→ 卡落在播放头处、被选中、右栏参数面板显示它。
- 点视频 → 「设为画布参考视频」后画布换视频、项标「参考视频」按钮变 ✓;「设为口播视频」后项标「口播」。
- 点字幕 → 下方展开句子;「用作本期字幕稿」→ 项标「使用中」、按钮 ✓;点句 → 播放头跳过去;播放时高亮句跟着走并自动滚动。
- 控制台没有新增报错(尤其没有 button 套 button 的 hydration 警告)。

---

## 进度(2026-09-06)

- A / B / C 三部分和接线都已落盘,tsc 0 错误,lint 与基线一致(TopBar 三条 only-export-components 老警告)。
- 在 127.0.0.1:5199 实测通过:左栏「编辑台 | 素材库」分页;顶栏没有分页按钮;悬停动效卡约 0.2 秒后浮出预览(Canvas 单卡模式,动画在动)、移开消失、列表滚动消失、拖动时不出现;悬停期间 `window.__fxExportMs` 始终未定义;拖动效卡到序列的空档 → 落卡,拖到「新建轨道」落区 → 新建序列落卡;点卡 →「＋ 加到 序列n」→ 落到播放头处并选中;视频「设为画布参考视频 / 设为口播视频」→ 徽章和 ✓;字幕展开句子、「用作本期字幕稿」→ 只有那一份标「使用中」、点句播放头跳到 0:05.5。
- 没能在浏览器面板里验的一条:「播放时高亮句跟着走」—— Claude 的内嵌浏览器面板不派发 requestAnimationFrame,编辑台时钟在那里根本不走;逻辑上高亮只依赖 `curT`(点句跳转已验证 `.is-now` 跟着 curT 变),真机播放即可确认。
- 顺带:`src/uploadDemo.ts` 无人引用,已删。
