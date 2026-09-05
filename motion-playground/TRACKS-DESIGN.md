# 编辑台多轨道改造 · 契约(T1 / T2 / T3 并行)

三个任务同时改不同文件。**只能改自己那一列的文件;共享接口以本文件为准,拿不准就按这里写的名字和类型做,不要自己发明。**
仓库根是 `motion-playground/`(本仓库的编辑器子目录),所有路径相对它。

| 任务 | 只能改这些文件 | 不许碰 |
|---|---|---|
| T1 时间轴 | `src/components/TimelineBar.tsx`、新建 `src/components/TimelineBar.css` | App.tsx、Sidebar.tsx、App.css、hud.css、overlay/* |
| T2 侧栏 | `src/components/Sidebar.tsx`、新建 `src/components/SidebarTracks.css` | App.tsx、TimelineBar.tsx、App.css、hud.css、overlay/* |
| T3 App 接线 | `src/App.tsx`、`src/components/ParamsPanel.tsx`、新建 `src/components/ParamsPanelTrack.css` | TimelineBar.tsx、Sidebar.tsx、App.css、hud.css、overlay/* |

`scripts/`、`vite.config.ts`、`desktop/` 另一条工作流正在改,**任何任务都不许动**。验证只用 `npx tsc -b --noEmit`(或 `npx tsc -p tsconfig.app.json --noEmit`)和 `npm run lint`,不要起 5177 端口的 dev server(被别的流程占着);要看效果就 `npx vite --port 5199`。

## 已经做好的基础(不用再做,直接用)

`src/overlay/types.ts`:
- `OverlayCard.track?: number` —— 所在轨道,1 起;没写 = 1。`parseOverlay` 已会读写它。
- `OverlayDoc.tracks?: number` —— 轨道数;`parseOverlay` 已会读它。
- `trackOf(card): number` —— 取轨道号,老档没写返回 1。

`src/overlay/cardLabel.ts`:
- `effectName(kind): string` —— 加粗那段(registry 里的 name,如 ChapterBar)。
- `cardSummary(card): string` —— 不加粗那段(卡里最主要的一段文案,单行,可能为空串)。截断交给 CSS。

## 概念

- **轨道**(track / 序列轨道):编辑台里把卡片分成 V1、V2、…、Vn 几层。`轨道数 = max(doc.tracks ?? 1, 所有卡里最大的 track)`,这个数由 App 算好通过 `trackCount` 传下去,T1/T2 自己不要重复算。
- 同一轨道内时间重叠的卡**仍然**沿用现有的 `assignLanes` 自动分行(每条轨道内部独立分行),老档所有卡都在 V1,外观和现在一样。
- 轨道只影响编辑台显示、左栏分组;渲染、导出、体检器完全不看它。

## 接口契约

### TimelineBar(T1 实现,T3 调用)

现有 props 全部保留,新增:

```ts
/** 轨道数(≥1),V1..Vn */
trackCount: number;
/** 点「＋ 添加序列轨道」 */
onAddTrack: () => void;
/** 从效果库拖一张效果丢到轨道上:kind = 效果 id,start = 落点秒(已按 0.1s 取整),track = 落在哪条轨道(1 起) */
onDropEffect: (kind: string, start: number, track: number) => void;
/** 色块上下拖到别的轨道后写回 */
onTrack: (id: string, track: number) => void;
```

拖放数据格式(T2 写、T1 读):`dataTransfer` 的 MIME 类型 **`application/x-overlay-effect`**,值是效果 id 字符串(如 `chapter-bar`);`effectAllowed = "copy"`。
T1 在 `onDragOver` 里只要 `types` 含这个 MIME 就 `preventDefault()` 并 `dropEffect = "copy"`,`onDrop` 里读出来算 start 和 track 后调 `onDropEffect`。

### Sidebar(T2 实现,T3 调用)

现有 props 全部保留,新增:

```ts
/** 轨道数(≥1) */
trackCount: number;
/** 左栏当前看的是哪条轨道(1 起);字幕稿页签不算轨道 */
activeTrack: number;
/** 用户点了「轨道 n」页签 */
onSelectTrack: (track: number) => void;
```

### App(T3 实现)

- 状态:`activeTrack`(默认 1;轨道数变小时收回到范围内)。
- 派生:`trackCount = Math.max(overlay?.tracks ?? 1, ...cards.map(trackOf))`。
- `handleAddTrack`:`pushHistory(true)` 后 `setOverlay(o => ({...o, tracks: trackCount + 1}))`(overlay 为空时先建一份空编排),并把 `activeTrack` 切到新轨道。
- `handleDropEffect(kind, start, track)`:和现有 `handleAddToTimeline` 同一套建卡逻辑(id 递增、`addSecFor` 时长、`paramsById[kind]` 参数),只是 start/track 用传入的。
- `handleAddToTimeline`(现有「➕ 加入卡片」)建的卡落在 `activeTrack`。
- `handleCardTrack(id, track)`:`pushHistory(true)` 后改那张卡的 `track`。
- 把上面三组新 props 分别传给 `<TimelineBar>` 和 `<Sidebar>`。
- ParamsPanel:选中卡片时,面板顶部加一个「所在轨道」下拉(V1..Vn),改了调 `onTrack(id, track)`。ParamsPanel 新增 props `trackCount?: number`、`cardTrack?: number`、`onTrack?: (track: number) => void`(都可选,效果库预览态不传)。

## 各任务要做到的效果

### T1 时间轴(`TimelineBar.tsx` + `TimelineBar.css`)

1. 轨道区按 `trackCount` 分成 V1..Vn 几条横带,每条左侧固定一列标签 `V1`、`V2`…(横向滚动时标签列不动,用 sticky 或双层布局)。每条带内沿用 `assignLanes` 对该轨道的卡分行,带高 = 行数 × 行高,至少一行。
2. 色块内显示两段文字:`<b>{effectName(kind)}</b>` 加粗 + `cardSummary(card)` 常规字重,单行,`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`;色块太窄(约 < 60px)时只留加粗名,再窄就不显示文字。字色要在 `kindColor` 底色上可读(现有色块是纯色,文字用深色或加 0.15 透明黑底)。
3. 信息栏(`tlb-info`)里加按钮「＋ 添加序列轨道」→ `onAddTrack()`。
4. 轨道区外层加纵向滚动:`max-height` 取一个合理值(比如视口的 38%,或 6 条轨道的高度),超出时出现纵向滚动条,播放头竖线要贯穿全部轨道。现有的顶边抓手调行高照常工作。
5. 色块拖动:现有的横向平移/改起止不变;**纵向**拖过一条轨道带的高度就换轨道(松手时调 `onTrack(id, 新轨道)`),拖动过程中给个高亮提示。上下拖和左右拖可以同时发生。
6. 接受从效果库拖来的效果(见拖放数据格式):`onDragOver` 高亮落点轨道,`onDrop` 算 `start = round(落点秒, 0.1)`,`track = 落点所在带`,调 `onDropEffect`。
7. 空白处擦洗、缩放、磁吸对齐、键盘提示行全部保留。`trackCount = 1` 且老档时,除了色块上多了文字和左侧一个 `V1` 标签,其余外观尽量和现在一致。

### T2 侧栏(`Sidebar.tsx` + `SidebarTracks.css`)

1. 编辑台左栏原来的两个页签「卡片 N / 字幕稿 N」改成:`轨道 1 (n₁)`、`轨道 2 (n₂)`…`轨道 k (n_k)` + `字幕稿 N`。轨道页签数 = `trackCount`,当前页签 = `activeTrack`,点页签调 `onSelectTrack(n)`;字幕稿页签仍是本地的 `view === "srt"` 状态。页签多时允许横向滚动或换行,别把「清空」「换 SRT」按钮挤没。
2. 轨道页签下的卡片列表只列 `trackOf(c) === activeTrack` 的卡,序号按该轨道内顺序从 01 起;列表项文字改成 `<b>effectName</b>` + `cardSummary`(常规字重,单行省略号),右侧时间不变。
3. 效果库页签(`tab === "library"`)里每个效果项加 `draggable`,`onDragStart`:`e.dataTransfer.setData("application/x-overlay-effect", effect.id)`、`effectAllowed = "copy"`;拖动时给个视觉反馈(半透明或描边),鼠标提示「拖到时间轴 = 加到那条轨道」。点选行为不变。
4. 「➕ 加入卡片」按钮的文案后面带上目标轨道,例如「➕ 加入 V2」。

### T3 App 接线(`App.tsx` + `ParamsPanel.tsx`)

按「接口契约 › App」逐条实现;`handleAddToTimeline` 和 `handleDropEffect` 共用一个内部函数,避免两份建卡逻辑。
撤销/重做快照沿用 `pushHistory`,`tracks` 在 `overlay` 里自然进快照;自动存档和导出 JSON 因为直接序列化 `overlay`,`track`/`tracks` 会自动带上。
新增 props 传给子组件时按契约里的名字写;子组件还没实现新 props 时 `tsc` 会报错,这是预期的 —— 三个任务合并后由集成步骤统一跑 `tsc`。

## 验收(集成时统一做)

- `npx tsc -p tsconfig.app.json --noEmit` 无错;`npm run lint` 不新增 error。
- 载入示例(10 张卡)后:时间轴左侧有 `V1` 标签,色块上有加粗效果名 + 摘要;左栏页签是「轨道 1 (10)」「字幕稿 …」。
- 点「＋ 添加序列轨道」→ 出现 V2 带、左栏多出「轨道 2 (0)」页签;把一张卡往下拖到 V2 → 它出现在 V2 带和「轨道 2」页签下,V1 少一张。
- 效果库里拖一张效果到 V2 的某个时间点 → 那里出现一张新卡,参数面板选中它,「所在轨道」显示 V2。
- 加到 8 条轨道后轨道区出现纵向滚动条,播放头贯穿。
- 导出 JSON 里卡片带 `track`、顶层带 `tracks`;老 JSON 导入后一切落在 V1,和改前一样。

---

# 第二轮(U1 / U2 / U3 并行):用户手测后的 4 个问题

分工和第一轮一样按文件边界:U1 只改 `src/components/TimelineBar.tsx` + `TimelineBar.css`;U2 只改 `src/components/Sidebar.tsx` + `SidebarTracks.css`;
U3 只改 `src/App.tsx` + 新建 `src/components/ConfirmDialog.tsx` + `ConfirmDialog.css`。App.css / hud.css / overlay/ / scripts/ / vite.config.ts / desktop/ 谁都不碰。
验证用 `npx tsc -p tsconfig.app.json --noEmit` 和 `npm run lint`;5177 不许占;5199 上现在有一个正在跑的 vite(别再起第二个,strictPort 会失败),要看效果直接开 `http://127.0.0.1:5199/`。

**已核实的事实**:「清空按钮无效」不是代码 bug —— 用户在 Claude 桌面应用的浏览器面板里测的,那个面板会把原生 `window.confirm()` 自动按取消(实测 3ms 返回 false,不显示任何东西)。
`载入示例`、`导入 JSON`(时间轴有卡时)、`清空` 这几处都靠 confirm 守卫,在这类内嵌浏览器里全部静默失效。修法是把 confirm 换成页内确认框(U3)。

## 接口变化(U1 发出,U3 接收;向后兼容,只加可选参数)

```ts
/** 第 4 个参数可选:insert = true 表示「在 track 这个位置插入一条新轨道,原来 ≥ track 的轨道全部下移一位,再把卡放进新轨道」 */
onDropEffect: (kind: string, start: number, track: number, opts?: { insert?: boolean }) => void;
onTrack: (id: string, track: number, opts?: { insert?: boolean }) => void;
```

`track` 的取值:插在 V1 上方 = 1;插在 Vi 和 Vi+1 之间 = i+1;插在最后一条下方 = trackCount+1。

## U1 时间轴(TimelineBar.tsx + TimelineBar.css)

保留上一轮的一切,尤其是「拖动中色块浮动跟手 + 冻结分行 + 4px 横向死区」那套(`drag` state / `frozenRef` / `.tlb-card.is-dragging`),别删。

1. **带间隙落点 = 新建轨道**。色块的指针拖动和效果库的 HTML5 拖放都适用:指针落在两条轨道带的分界线上下各 5px 内、或最后一条带下方(留一条 14px 高的「＋ 拖到这里新建轨道」落区,常驻但不显眼,拖动时高亮),就显示一条贯穿整个宽度的插入线(accent 色,带小字「新建轨道」),此时不高亮任何现有带;松手/drop 时按上面的规则调 `onTrack(id, pos, { insert: true })` 或 `onDropEffect(kind, start, pos, { insert: true })`。落在带内部照旧。
2. **信息栏永远一行**。`.tlb-info` 在窄窗口下不许换行:`flex-wrap: nowrap; overflow: hidden; white-space: nowrap`,各项 `flex-shrink: 0`;按容器宽度分档收缩(用 `.tlb` 的 container query 或 `@media`):
   - < 1180px:隐藏 `.tlb-keys` 快捷键小抄;
   - < 900px:「当前 / 总时长 / 显示」三项合成一项 `0:12.3 / 0:28.0 · 显 2`,缩放按钮保留;
   - < 700px:「＋ 添加序列轨道」缩成「＋ 轨道」。
   先去 App.css 找到是谁让它换行的(疑似 2290–2335 行附近的响应式规则),用 TimelineBar.css 里更高特异性的选择器覆盖,不改 App.css。轨道区(`.tlb-track`)的高度不因信息栏而变。
3. 顺手核一下 V 标签列在轨道很多(≥14)且横向缩放到 8× 时仍 sticky 在左边、不遮第一张卡。

## U2 侧栏(Sidebar.tsx + SidebarTracks.css)

1. **轨道页签左右箭头**。`.side-tracks-scroll` 两端各加一个按钮 `‹` / `›`(class `side-tracks-arrow`),只在页签溢出时显示(用 ResizeObserver 或 scroll 事件比较 `scrollWidth > clientWidth`),点一下滚动可视宽度的 60%,到头的那一侧禁用;`activeTrack` 变化时把当前页签 `scrollIntoView({ inline: "nearest", block: "nearest" })`。「字幕稿」页签和「清空 / 换 SRT」按钮仍在滚动区外,永远可见。
2. 页签过多时给个位置感:在箭头旁显示 `当前/总数`(如 `3/14`),字号 11px、muted 色;不溢出时不显示。
3. 不动清空按钮的逻辑(它调 `onClearOverlay`,守卫在 App 里,由 U3 处理)。

## U3 App(App.tsx + ConfirmDialog.tsx + ConfirmDialog.css)

1. **插入轨道语义**。`handleCardTrack(id, track, opts?)` 和 `handleDropEffect(kind, start, track, opts?)` 接第 4/第 3 个可选参数:`opts?.insert` 为真时,在**一次** `pushHistory(true)` 和**一次** `setOverlay` 里完成:`tracks = max(当前 trackCount, ...) + 1`;所有 `trackOf(c) >= track` 的卡 `track += 1`;然后把目标卡放到 `track`(拖卡就是改它的 track,拖效果就是新建卡)。`activeTrack` 跟到新轨道。传给 `<TimelineBar>` 的两个回调按新签名传。
2. **页内确认框**。新建 `components/ConfirmDialog.tsx`:一个受控的小模态(遮罩 + 卡片:标题可选、正文支持 `\n` 换行、「确定」「取消」;Enter = 确定,Esc = 取消;打开时焦点落在「取消」上,遮罩点击 = 取消),样式跟现有面板配色(用 App.css 里已有的 `--bg-panel` / `--ink` / `--accent` 变量),写在 `ConfirmDialog.css`。
   在 App 里提供 `askConfirm(message, title?): Promise<boolean>`(用 state 存当前请求 + resolver),把 App.tsx 里所有 `confirm(` / `window.confirm(` 调用(清空、载入示例、导入 JSON 替换,以及第 194 行附近那处,自己 grep 确认)全部换成 `await askConfirm(...)`,对应 handler 改成 async。文案原样保留。
   为什么:内嵌浏览器(Claude 桌面应用的浏览器面板、部分 WebView)会把原生 confirm 自动按取消,守卫静默失效,用户看到的是「按钮无效」。`alert(` 这一轮先不动。
3. 清空之后 `tracks` 也归零(`setOverlay(null)` 已经做到),`activeTrack` 收回 1。

## 验收(集成时统一做)

- tsc 零错误,lint 不新增。
- 在 5199 预览里:把一张卡拖到 V1 和 V2 之间松手 → 出现新的 V2,原 V2 变 V3,卡在新 V2 上;从效果库拖到最后一条带下方 → 末尾新增一条轨道并落卡。
- 把窗口(或浏览器面板)缩到 700px 宽:时间轴信息栏仍是一行,轨道区高度不变。
- 加到 14 条轨道:左栏出现 ‹ › 箭头和 `n/14`,点 › 能滚到「轨道 14」;点页签后当前页签自动滚入视野。
- 点「清空」:出现页内确认框;取消 → 什么都不变;确定 → 卡片、字幕稿清空,页签回到「轨道 1 (0)」。载入示例、导入 JSON 的替换确认同样走页内框。

---

# 第三轮(W1 / W2 / W3 并行):抓手、行高档位、横向平移、拖标签调顺序、「V」改「序列」

分工按文件边界:W1 只改 `src/components/TimelineBar.tsx` + `TimelineBar.css`;W2 只改 `src/App.tsx`;W3 只改 `src/components/Sidebar.tsx` + `SidebarTracks.css` + `src/components/ParamsPanel.tsx` + `ParamsPanelTrack.css`。
App.css / hud.css / overlay/ / scripts/ / vite.config.ts / desktop/ 谁都不碰。验证用 `npx tsc -p tsconfig.app.json --noEmit` 和 `npm run lint`;5177 不许占;5199 上有一个正在跑的 vite(别再起第二个),看效果直接开 `http://127.0.0.1:5199/`。

**已有基础**:`src/overlay/cardLabel.ts` 新增 `trackLabel(n)` → `序列${n}`,所有界面上的轨道名都从它取。

## 已核实的现状

- 时间轴顶边的抓手 `.tlb-resize`(App.css 680 行起)现在拖的是 `laneH`(色块行高,`startResize` → `setLaneH`,记在 localStorage `tlbLaneH`),用户以为它是「调整时间轴面板高度」的分隔条。
- `.tlb` 在 App.css 里是 `flex: none; max-height: 42vh`;`.tlb-track`(滚动容器)在 TimelineBar.css 里 `max-height: 38vh`。面板高度目前完全由内容决定,没有可拖的布局。
- `.tlb-vlabel` 是 `pointer-events: none` 的 sticky 标签(为了不挡 0 秒处的卡和右键)。

## 接口变化(W1 发出,W2 接收)

```ts
/** 拖标签调顺序:把第 from 条轨道挪到第 to 条的位置(都是 1 起的序号;to 是「挪完之后它排第几」),中间的整体顺移 */
onReorderTrack?: (from: number, to: number) => void;
```

## W1 时间轴(TimelineBar.tsx + TimelineBar.css)

保留上两轮的一切(浮动跟手、冻结分行、带间隙插入、右键菜单、信息栏一行、容器查询分档)。

1. **顶边抓手改成调面板高度**。`startResize` 改为拖 `trackH`(轨道区 `.tlb-track` 的固定高度,px):初值 `localStorage.tlbTrackH`,没有就 `Math.round(window.innerHeight * 0.32)`;范围 `[96, window.innerHeight * 0.7]`;拖动中实时 `setTrackH`,松手写回 localStorage。`.tlb-track` 用 inline style `height: trackH`(不再靠 max-height),`.tlb` 的 `max-height: 42vh` 用 TimelineBar.css 更高特异性覆盖成 `none`,画布区 `flex: 1` 会自动让位。抓手的 title 改成「上下拖 = 调整时间轴面板高度」。
2. **行高三档按钮**。信息栏加一组 `小 / 中 / 大`(class `tlb-lane-size`,当前档高亮):`小 = 16`、`中 = 22`、`大 = 32`(px,写进 `laneH`,仍记 `tlbLaneH`)。窄窗口分档规则:< 900px 时按钮缩成只显示当前档一个字、点击轮换。
3. **横向平移**。两种都要:(a) `.tlb-track` 的横向滚动条常显(`overflow-x: scroll` 或 `scrollbar-gutter: stable`,样式和现有 `.side-tracks-scroll` 的细滚动条一致);(b) 中键按住拖、或 Alt + 左键按住拖 = 抓手平移(改 `scrollLeft`,光标 `grabbing`),不触发擦洗和选卡;Shift + 滚轮 = 横向滚(浏览器默认行为别拦)。
4. **标签可拖、调顺序**。`.tlb-vlabel` 去掉 `pointer-events: none`,改成 `cursor: grab`;在标签上 `pointerdown`(左键)开始「拖轨道」:跟手的是整条带的半透明浮影(或只浮标签,但要有一条插入线指示落点),纵向越过其他带的中线就更新落点;松手 `onReorderTrack?.(from, to)`,没移动 = 什么都不做。右键仍弹轨道菜单(标签上右键也要能弹)。标签文案改成 `trackLabel(track)`(「序列1」);标签列宽度按最长标签自适应(「序列12」比「V12」宽)。
5. 卡片色块上的行为(拖动、改起止、磁吸、换轨道、间隙插入)一处不变。

## W2 App(App.tsx)

1. `handleReorderTrack(from, to)`:`from === to` 直接返回;`pushHistory(true)` 后一次 `setOverlay`:对每张卡按 `trackOf(c)` 重编号 —— 等于把长度为 trackCount 的序号数组里第 from 项挪到第 to 项(其余顺移),再按新位置写回 `track`(回到 1 时写 `undefined`,和现有习惯一致);`tracks` 不变。`activeTrack` 如果等于 from 就跟到 to,否则按同样的顺移规则算。
2. `<TimelineBar>` 多传 `onReorderTrack={handleReorderTrack}`。
3. 别的不动。

## W3 文案(Sidebar.tsx + SidebarTracks.css + ParamsPanel.tsx + ParamsPanelTrack.css)

1. 所有出现「V」+数字的地方改用 `trackLabel(n)`:左栏溢出时的缩写(现在是 `V17 (0)` → `序列17 (0)`)、效果库提示条「➕ 加入 V{n}」、编辑台空状态文案、参数面板「所在轨道」下拉的选项(`V1..Vn` → `序列1..`)、「＋ 加到 V2 …」按钮。左栏页签正常态仍是「轨道 n (k)」(用户第一轮点名的叫法)。
2. 缩写变宽后左栏页签的横向滚动、箭头、`n/N` 计数要仍然正常。
3. 不动任何逻辑。

## 验收(集成时统一做)

- tsc 零错误,lint 不新增。
- 拖时间轴顶边:轨道区高度跟着鼠标变(96px ~ 70% 视口),画布相应缩放;刷新后记住。色块行高不变。
- 点「小 / 中 / 大」:色块行高 16 / 22 / 32,带高随之变;刷新后记住。
- 放大到 4×:横向滚动条常显;中键或 Alt+左键按住拖能平移,擦洗不触发;Shift+滚轮横向滚。
- 拖「序列3」标签到「序列1」上方松手:原序列3 的卡变成序列1,原 1、2 变 2、3;左栏页签计数同步;⌘Z 撤销。
- 界面上再没有「V1」字样;标签列不遮 0 秒处的卡;右键标签仍弹菜单。

---

# 第五轮(V1 / V2 / V3 / V4 并行):全局设置迁移

用户拍板:左栏「全局 · 影响所有卡片」整区删掉;顶栏 ⚙ 拆成两个面板 ——「全局风格」(存进编排 JSON、导出生效)和「显示设置」(只影响这台电脑的编辑台);
原来的全局「特效整体大小 / 动画速度」是**隐藏乘数**(不进 JSON、不存本地,刷新归 1,同一份 JSON 换台机器导出结果不同),取消它,改成参数面板里的「所有卡片 · 批量」滑杆,拖一下直接写进每张卡自己的 `scale` / `speed` 参数。

分工按文件:V1 只改 `src/components/TopBar.tsx` + 新建 `src/uploadDemo.ts`;V2 只改 `src/components/Sidebar.tsx`(+ `SidebarTracks.css`);V3 只改 `src/components/ParamsPanel.tsx`(+ `ParamsPanelTrack.css`);V4 只改 `src/App.tsx`。
Canvas.tsx、TimelineBar.*、StageControls.*、App.css、overlay/、scripts/、desktop/ 谁都不碰。验证用 `npx tsc -p tsconfig.app.json --noEmit` + `npm run lint`;5177 不许占;5199 上有一个别人起的 vite,直接开 `http://127.0.0.1:5199/` 看效果,不要再起。
四个任务并行时 tsc 会有跨文件的 props 不匹配,那是别的任务还没落地,汇报里区分开;各自文件自身必须零错误。

## 已核实的事实

- 现在 ⚙ 面板(TopBar.tsx `usePrefsPopover` + `prefsOpen`,portal 挂到 body)里有:全局主色(`onUnifyAccent`)、全局文字色(`inkColor`/`onInkColor`)、全局字体(`font`/`onFont`)、文字光晕(`glow`/`onToggleGlow`)、编辑台风格(`form`/`onForm`)、编辑台配色(`palette`/`onPalette`)、安全区参考线(`showGuides`)、人物占位(`showPerson`)。
- 左栏 `.sidebar-foot`(Sidebar.tsx 约 527 行起)里有:全局底色(`onGlobalTheme`)、皮肤(`skin`/`onSkin`,选项 `SKIN_OPTIONS`)、风格(`docStyle`/`onDocStyle`,选项 `STYLE_OPTIONS`,都从 `effects/hud/accent` 来)、侧边色块(`sideColor`/`onSideColor`,只在 sketch 风格显示)、导入视频/清除(`onVideo`)、导入 JSON(`onImportJson`)、导出 JSON(`onExportJson`)、口播视频(`cam`/`onSetCam`,上传走 `POST /api/upload-demo?name=`,成功返回 `{ok, src}`)、导出整条时间轴(`onExport`)、视频画面缩放(`videoScale`/`onVideoScale`,只影响画布预览)、特效整体大小(`fxScale`)、动画速度(`animSpeed`)。
- Canvas 里每张卡的实际缩放 = `fxScale × params.scale`,速度 = `animSpeed × params.speed`(Canvas.tsx 102/104 行)。每张卡本来就有 `scale`(卡片大小 0.4–3)和 `speed`(动画速度 0.3–3)两个通用参数(ParamsPanel 的 SCALE_CONTROL / SPEED_CONTROL)。所以全局乘数取消后,App 给 Canvas 传常量 1 即可,Canvas 不用改。
- 导出时 App 把 `scale: fxScale, speed: animSpeed` 放进导出任务(App.tsx 约 1149 行);取消后传 1。
- 顶栏右侧已有「导入 JSON」「🎬 示例」「导入视频」「⬇ 导出透明 MOV」,所以左栏那几个重复按钮直接删;「导出 JSON」顶栏没有,要补。

## 接口契约

### TopBar(V1 实现,V4 调用)

现有 props 全部保留,新增(名字逐字):

```ts
/** 编排底色:所有卡片亮/暗(存 doc.theme) */
theme: "dark" | "light" | undefined;
onGlobalTheme: (theme: "dark" | "light") => void;
/** 皮肤 / 风格 / 侧边色块(存 doc.skin / doc.style / doc.sideColor;空串 = 默认) */
skin: string;
onSkin: (s: string) => void;
docStyle: string;
onDocStyle: (s: string) => void;
sideColor: string;
onSideColor: (c: string) => void;
/** 口播视频(存 doc.cam):运镜卡另用一条视频;空串 = 跟随导入的视频 */
cam: string;
onSetCam: (src: string) => void;
/** 视频画面缩放(只影响画布预览,不进 JSON) */
videoScale: number;
onVideoScale: (v: number) => void;
/** 导出编排 JSON */
onExportJson: () => void;
```

### 共享上传函数(V1 新建 `src/uploadDemo.ts`)

```ts
/** 把素材传进 public/demo/,返回可用的 src 路径;失败 throw Error(原因)。TopBar 的口播视频用它;ParamsPanel 自己那套 MediaRow 这轮不动 */
export async function uploadDemo(file: File): Promise<string>;
```
实现和 Sidebar 现在的 `pickCam` 一样:`fetch(\`/api/upload-demo?name=${encodeURIComponent(file.name)}\`, { method: "POST", body: file })` → `data.ok ? data.src : throw`。错误文案用 `uploadErrText`(`src/uploadErr.ts`)。

### Sidebar(V2 实现,V4 调用)

删掉这些 props(V4 同步不再传):`onGlobalTheme, skin, onSkin, docStyle, onDocStyle, sideColor, onSideColor, cam, onSetCam, onVideo, hasVideo, videoBusy, fxScale, onFxScale, animSpeed, onAnimSpeed, videoScale, onVideoScale, onExportJson, onExport, exporting`。
保留:`tab, effects, selectedId, onSelect, onReplay, overlay, selCardId, srt, curT, onSeek, onImportSrt, onSelectCard, onImportJson, onClearOverlay, trackCount, activeTrack, onSelectTrack, trackNames`。
(V2 动手前先 grep 每个 prop 在 Sidebar.tsx 里的用处:效果库页签底部的「▶ 重放动画」按钮用 `onReplay`,要留;编辑台空状态里的「📥 导入 JSON」链接用 `onImportJson` + `jsonRef`,要留。)

### ParamsPanel(V3 实现,V4 调用)

现有 props 全部保留,新增可选:

```ts
/** 所有卡片的批量值:count = 卡数;scale / speed = 所有卡一致时是那个值,不一致是 null;没有卡时不传 */
batch?: { count: number; scale: number | null; speed: number | null };
/** 把 patch 写进每一张卡的 params(App 一次 pushHistory + 一次 setOverlay) */
onApplyAll?: (patch: Record<string, unknown>) => void;
```

### App(V4 实现)

- 删掉 `fxScale` / `animSpeed` 两个 state 和所有 set 调用;给 `<Canvas>` 传 `fxScale={1}` `animSpeed={1}`(Canvas 不改);导出任务里 `scale: 1, speed: 1`。
- 保留 `videoScale` state,传给 TopBar(`videoScale`/`onVideoScale`)和 Canvas。
- `handleApplyAll(patch)`:`pushHistory(true)`;`setOverlay(o => o ? { ...o, cards: o.cards.map(c => ({ ...c, params: { ...c.params, ...patch } })) } : o)`。
- `batch` 派生(useMemo):count = cards.length;scale = 所有卡 `Number(c.params.scale) || 1` 全相等则该值否则 null;speed 同理用 `params.speed`。
- 给 `<TopBar>` 传新 props:`theme={overlay?.theme}`、`onGlobalTheme={handleGlobalTheme}`(已有)、`skin`/`onSkin`/`docStyle`/`onDocStyle`/`sideColor`/`onSideColor`/`cam`/`onSetCam`(现在传给 Sidebar 的那几个 lambda 原样挪过去)、`videoScale`/`onVideoScale`、`onExportJson={handleExportJson}`。
- 给 `<Sidebar>` 去掉上面列出要删的 props;给 `<ParamsPanel>` 传 `batch`(overlay 有卡时)和 `onApplyAll={handleApplyAll}`。

## 各任务要做到的效果

### V1 顶栏(TopBar.tsx + uploadDemo.ts)

1. ⚙ 一个按钮变两个:「🎨 全局风格」和「🖥 显示设置」,各自一个弹出面板,复用现有 `usePrefsPopover` 的定位/关闭逻辑(改成能区分开的是哪个面板)。两个不能同时开。
2. 「全局风格」面板顶部一行小字:「存进编排文件,导出时生效」。内容按顺序:全局底色(🌙 暗底 / 🌞 亮底 两个按钮,当前值高亮)、全局主色(现有)、全局文字色(现有)、全局字体(现有)、文字光晕(现有)、皮肤(select,`SKIN_OPTIONS`)、风格(select,`STYLE_OPTIONS`)、侧边色块(只在 `docStyle === "sketch"` 时显示,color input + 清除)、口播视频(一行:当前路径或「跟随导入的视频」+「选择」按钮走 `uploadDemo` + 「清除」;上传中按钮禁用并显示「⏳ 上传中…」;失败 alert)。`hasDoc` 为假时和现有控件一样禁用。
3. 「显示设置」面板顶部一行小字:「只影响这台电脑上的编辑台,不进文件」。内容:编辑台风格、编辑台配色、安全区参考线、人物占位(都是现有的)、视频画面缩放(range 0.5–2 step 0.05,显示百分比,和左栏原来那个一样)。
4. 顶栏右侧「导入 JSON」旁边加「📤 导出 JSON」(`onExportJson`,`hasDoc` 为假时禁用),只在编辑台页签显示。
5. 样式:沿用现有 `.tb-prefs*` 类,新元素用新类名写在 TopBar 已有的样式来源里(TopBar 的样式在 App.css,**不许改 App.css**;需要新样式就新建 `src/components/TopBarPrefs.css` 并在 TopBar.tsx import)。

### V2 左栏(Sidebar.tsx)

1. 删掉编辑台的整个「全局 · 影响所有卡片」区(`.sidebar-foot` 里 `foot-kicker` 起到区末),连同不再用的 refs(`fileRef`、`camRef`)、`pickCam`、`camUploading` 和上面列出的 props。效果库页签的「▶ 重放动画」按钮保留。
2. 编辑台空状态里「📥 导入 JSON」链接照常可用。
3. `SidebarTracks.css` 里若有只被删掉部分引用的规则,一起删。
4. 删完 `npx tsc` 时 Sidebar.tsx 自身零错误、无未使用变量(`noUnusedLocals`)。

### V3 参数面板(ParamsPanel.tsx)

1. 新增一个「所有卡片 · 批量」区块(class `pp-batch`):两个滑杆「卡片大小(所有卡)」0.4–3 step 0.05 和「动画速度(所有卡)」0.3–3 step 0.05,右侧显示当前值(`batch.scale` 为 null 时显示「混合」,滑杆停在 1);拖动 → `onApplyAll({ scale: v })` / `onApplyAll({ speed: v })`。每个滑杆旁一个「1×」小按钮 = 重置。区块顶部一行小字:「改的是每张卡自己的参数,会存进文件」。
2. 显示位置:编辑台模式下两处 —— (a) `editMode && !card` 的空状态面板底部;(b) 选中卡片时「常规」页最底部(在现有分组之后)。效果库预览态不显示。`batch` 没传或 `count === 0` 时整块不渲染。
3. 样式写在 `ParamsPanelTrack.css`(已 import),用现有 `.ctrl` / `.ctrl-head` / `.ctrl-val` 类。

### V4 App(App.tsx)

按「接口契约 › App」逐条实现。注意 `handleGlobalTheme` 已存在;`onSkin` 等 lambda 从 `<Sidebar … />` 挪到 `<TopBar … />`;`onSetCam` 那段有「手动选过就不跟随导入视频」的逻辑,原样保留。删 state 时把所有引用一起清掉(grep `fxScale` / `animSpeed` / `setFxScale` / `setAnimSpeed`)。

## 验收(集成时统一做)

- tsc 零错误、lint 不新增。
- 左栏编辑台下方不再有「全局」区;顶栏有「全局风格」「显示设置」两个按钮和「导出 JSON」。
- 「全局风格」里切亮底 → 所有卡变亮,自动存档 `theme` 变;选皮肤 rose → `skin` 进 JSON;口播视频上传后 `cam` 进 JSON,清除后为空。
- 「显示设置」里拖视频画面缩放 → 画布视频变,刷新后 JSON 里没有它。
- 参数面板「所有卡片 · 批量」拖卡片大小到 1.3 → 每张卡 `params.scale === 1.3`,左栏/时间轴不变,自动存档里每张卡都带 1.3;⌘Z 一步撤回;改一张卡的单卡大小后批量值显示「混合」。
- 导出任务体里 `scale: 1, speed: 1`。

---

# 第六轮(W1 / W2 并行,W3 随后):参考线开关进播放栏、视频序列、标签列宽

用户要求:(1) 「安全区参考线」「人物占位」两个开关从顶栏「显示设置」挪到画面下方的播放操作栏,做成两个按钮;
(2) 用户导入的视频在时间轴上作为独立的序列显示,自动命名「视频序列1」「视频序列2」…;
(3) 序列标签列的宽度按文字实际宽度动态算 —— 现在「序列1」两边空白太多,要紧凑,但**绝不能把标签挤到换行**。

分工:W1 只改 `src/components/StageControls.tsx` + `StageControls.css`;W2 只改 `src/components/TimelineBar.tsx` + `TimelineBar.css`;
W3(TopBar.tsx 删两个开关、App.tsx 接线)等「界面 (fork)2」确认没在改这两个文件后再做。其余文件谁都不碰。
验证用 `npx tsc -p tsconfig.app.json --noEmit` + `npm run lint`;5199 上有别人起的 vite,直接开看,不要再起;5177 不许占。W3 落地前 tsc 会报 StageControls / TimelineBar 的新 props 没人传,属预期。

## 已核实的事实

- 顶栏「显示设置」里的两个开关是 TopBar props `showGuides / onToggleGuides / showPerson / onTogglePerson`(TopBar.tsx 98–101 行),App 传的是自己的 state。
- StageControls.tsx 现有 props:`curT, duration, playing, muted, onPlayPause, onReset, onToggleMute`,按钮用 `.stc-btn`。
- App 里导入的视频只有一条:`videoUrl`(落盘后是 `/_media/<文件名>` 形式)+ `videoDur`(秒,Canvas 的 onVideoMeta 回填);没有单独存文件名,文件名从 `videoUrl` 的最后一段 `decodeURIComponent` 得到。总时长 `duration = max(卡片结束, videoDur)` 已经把视频算进去了。
- TimelineBar 标签列宽 `gutterW`(TimelineBar.tsx 234 行起)现在是「按字符估宽:中日韩 11px、其余 7px,最多 12 字,+12」,估得偏宽;格子 `.tlb-gutter-cell` 是 `display:flex; justify-content:center`。

## 接口契约

### StageControls(W1 实现,W3 调用)

现有 props 保留,新增(名字逐字、和 TopBar 原来的一样):

```ts
showGuides: boolean;
onToggleGuides: () => void;
showPerson: boolean;
onTogglePerson: () => void;
```

### TimelineBar(W2 实现,W3 调用)

现有 props 保留,新增可选:

```ts
/** 导入的视频,每条一个「视频序列」:name 由 App 给(视频序列1、视频序列2…),offset 默认 0(以后素材库允许挪位置) */
videoTracks?: { id: string; name: string; src: string; duration: number; offset?: number }[];
```

### App(W3 实现)

- `<TopBar>` 不再传 `showGuides / onToggleGuides / showPerson / onTogglePerson`(TopBar 删掉这 4 个 props 和「显示设置」里的两个开关);改传给 `<StageControls>`。
- `videoTracks` 派生(useMemo):`videoUrl && videoDur > 0 ? [{ id: "video-1", name: "视频序列1", src: videoUrl, duration: videoDur }] : []`;写成数组 map 的形式(`视频序列${i + 1}`),以后多条视频直接扩。传给 `<TimelineBar videoTracks={…}>`。

## 各任务要做到的效果

### W1 播放操作栏(StageControls.tsx + .css)

1. 操作栏右侧加两个开关按钮:「▦ 安全区」和「👤 人物占位」(文案短一点,操作栏宽度有限),复用 `.stc-btn`,开着时加 `is-on`(和「播放中点亮」同一套样式),`aria-pressed` 同步,`title` 写全称「安全区参考线(只影响预览,不进导出)」「人物占位(只影响预览)」。
2. 放在时间读数右边、用一个细分隔线隔开;操作栏整体仍是一行,窄窗口下按钮只缩 padding 不换行、不溢出(`flex-shrink: 0` + 文案不折行)。

### W2 时间轴(TimelineBar.tsx + .css)

1. **视频序列**:`videoTracks` 里每条在**所有卡片序列的下方、「＋ 拖到这里新建轨道」落区的上方**渲染一条带(class `tlb-band tlb-band--video`),带高 = laneH(一行);标签列对应一格(class `tlb-gutter-cell tlb-gutter-cell--video`),文案 = `name`,前面带 🎞,和卡片序列的格子用略强的分隔线隔开。带内一个色块(class `tlb-video-clip`)从 `offset ?? 0` 到 `min(offset + duration, 总时长)`,底色用低饱和的中性色(不要占用 kindColor 的调色板),块内文字 = 文件名(从 `src` 最后一段 `decodeURIComponent`,省略号截断)。
   这一轮视频序列是**只读**的:不能选中、不能拖动、不能改起止、不能被当作卡片落点(`onDragOver` 不高亮、`onDrop` 忽略)、不参与轨道计数 / 插入 / 删除 / 换序 / 重命名;右键不弹菜单(或弹一个只有灰色「视频序列(只读)」的提示项)。播放头竖线、标尺、导航条都要把它算进可见高度。`videoTracks` 为空或未传时,外观和现在完全一致。
2. **标签列宽动态**:用 canvas `measureText` 量真实文字宽:字体取一个 `.tlb-gutter-cell` 的 `getComputedStyle` 拼出 `font-weight font-size font-family`(拿不到时兜底 `600 11px monospace`);量的对象 = 所有卡片序列标签(默认名或自定义名)+ 所有视频序列名(含 🎞 前缀);`gutterW = clamp(maxTextW + 2×6 + 2, 40, 160)`。依赖 `count / trackNames / videoTracks`,并在 `document.fonts.ready` 后再算一次(自定义字体加载完宽度会变)。超过 160 的在格子里省略号。
3. `.tlb-gutter-cell` 改成 `padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis`,`justify-content` 保持居中;任何情况下标签不换行。
4. 上一轮的一切(浮动跟手、间隙插入、右键菜单、改名、标尺、导航条、全局播放头、行高三档)保留。

### W3(等确认后做)

TopBar.tsx:删 `showGuides / onToggleGuides / showPerson / onTogglePerson` 4 个 props、解构和「显示设置」里的两个 switch(面板其余不动)。App.tsx:按「接口契约 › App」。

## 验收

- tsc 零错误、lint 不新增。
- 播放栏右侧有「▦ 安全区」「👤 人物占位」,点一下画布上的参考线 / 人物占位出现或消失,按钮点亮;「显示设置」里不再有这两项。
- 导入视频后时间轴底部出现「🎞 视频序列1」一条,色块长度 = 视频时长,块内是文件名;拖卡片到它上面不高亮、松手不落卡;右键无菜单;清除视频后这条消失。
- 标签列宽:只有「序列1」时格子两边各约 6px 空白;有「视频序列1」时列变宽到刚好放下;把某条改名成 20 个字,列宽停在 160、格内省略号;任何标签都不换行。

## 第六轮:一层一条序列(自动分层)

用户反馈:载入示例后所有卡落在序列 1,时间重叠的卡在同一序列里叠成好几层,「多个层共用一条序列」不符合预期,应该一层一条序列。

### 规则(types.ts `parseOverlay` / `packTracks`)

- 编排里**任何一张卡写了 `track`、或顶层写了 `tracks`**,都算这份编排自己管过序列,原样尊重、不重排。
- **完全没有序列信息**的编排(老档、AI 生成的 JSON、内置示例、刷新恢复的旧草稿)在解析时自动分层:
  按开始时间排序(同时开始的长卡在前),贪心放进第一条「上一张已结束」的序列,放不下就开新序列;首尾正好相接不算重叠。
- 结果写进每张卡的 `track`(序列 1 留空)和顶层 `tracks`,数组顺序不变(画布按数组顺序叠放)。导出 JSON 时一并带出,再次导入不再重排。
- 顶层 `tracks` **一律写**(只有 1 条也写 `tracks: 1`;有卡写了 track 但没顶层 tracks 的老档,解析时也补上 max(track)):
  分层过的编排必须自己说得清「我管过序列了」,否则分成一条序列的结果和从没管过序列的编排长得一样,刷新恢复 / 导出再导入会被再分一次层(审查发现)。
  有自定义序列名(`trackNames`)的编排同样算「管过序列」。
- 时间轴上的拖动也不再允许把卡放进已被占用的时段(用户定的:去掉「落进序列里已占用位置」这个分支):
  - 拖卡横向平移:只能在当前所在的空档里滑,顶到邻居就停,不会跳过一张卡;拖边缘伸缩同样顶到邻居为止。
  - 拖卡上下换序列:目标序列在这个时段有卡 → 那条带画成红色虚线「禁止」样式、浮动色块也变红;松手 = 不换序列、时间回到拖之前。横向再滑到空档就又能落。
  - 从素材库拖效果:落点在某张卡里面 → 禁止样式、不加;落在空档 → `onDropEffect(kind, start, track, { maxEnd })` 带上空档右边界,App 的 insertCard 应把新卡默认时长截到 `maxEnd`(App.tsx 侧待接)。
  - 落在两条序列之间(新建序列)永远允许。
  - App 侧已接(2026-09-06,overlay-studio-b1 会话):
    - `insertCard`(拖放 / 右键插入 / 素材库「＋ 加到 序列n」共用):不是「插入新序列」时,目标序列在 start 处有卡 → 从序列 1 起找第一条在这里空着的序列,都占了就开新序列;新卡时长 = min(默认时长, 同序列下一张卡的开始, `opts.maxEnd`),空档窄于 0.5 秒当作被占。加完 `setActiveTrack` 切到实际落下的那条序列。
    - `applySrtLines`(拖 .srt / 素材库字幕)自动生成的整段字幕卡:`track = trackCount + 1`,顶层 `tracks` 同步写成同一个数。
    - 选卡统一走 App 的 `selectCard(id)`:`setSelCardId` + `setActiveTrack(trackOf(card))`(左栏列表、时间轴点选、检查面板「定位」都走它)。
    - ParamsPanel 的 `onAddToTimeline / addAt / addSec / addTrack` 四个 props 已删(素材库窗口自己有「加到序列n」,没人再传)。
  - 仍会产生重叠的入口(有意保留:用户亲手改数字就是用户的决定):右栏「所在轨道」下拉、右栏起止时间输入、代码页直接改 JSON。

### 单条序列收起(TimelineBar.tsx/.css)

- 行高「中/大」时,序列标签下面有个文字胶囊按钮「收起」:只把这条序列缩到一行(小),其他序列不变;缩回后变「展开」。「小」档不显示按钮。
  (最早用 ︿ 箭头,10px 下像个「-」、用户认不出,改成文字。)
- 折叠集合只存在组件状态里(不落盘、不进 JSON)。序列号变动时按同一套映射搬家:插入(菜单 / 拖到两轨之间)、拖标签换序即时搬;删除序列要等 App 的页内确认落定、序列数真的减少后才搬,用户取消则不动。
