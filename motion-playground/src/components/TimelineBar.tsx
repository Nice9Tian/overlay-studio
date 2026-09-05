import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import type { OverlayCard } from "../overlay/types";
import { trackOf } from "../overlay/types";
import { effectName, cardSummary, trackLabel } from "../overlay/cardLabel";
import { kindColor } from "../effects/kindColor";
import { ContextMenu } from "./ContextMenu";
import "./TimelineBar.css";

interface TimelineBarProps {
  duration: number;
  t: number;
  cards: OverlayCard[];
  selectedId: string | null;
  /** 当前时间点显示中的卡片数 */
  /** 当前时刻在屏幕上的卡片数。信息条已不再显示它(顶栏 CARDS 有同一个数),字段保留只为兼容 App.tsx 的调用 */
  shown?: number;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
  /** 拖动色块 / 拖边缘后写回卡片时间 */
  onTimes: (id: string, start: number, end: number) => void;
  /** 轨道数(≥1),V1..Vn */
  trackCount: number;
  /** 点「＋ 添加序列轨道」 */
  onAddTrack: () => void;
  /** 从效果库拖一张效果丢到轨道上:kind = 效果 id,start = 落点秒(已按 0.1s 取整),track = 落在哪条轨道(1 起) */
  /** maxEnd:落点所在空档的右边界(秒),新卡的默认时长撞到下一张时应截到这里;没有 = 右边没卡 */
  onDropEffect: (kind: string, start: number, track: number, opts?: { insert?: boolean; maxEnd?: number }) => void;
  /** 色块上下拖到别的轨道后写回 */
  onTrack: (id: string, track: number, opts?: { insert?: boolean }) => void;
  /** 右键菜单「删除轨道 Vn」:该轨道上的卡一起删,后面的轨道整体上移一位(确认框由 App 弹) */
  onDeleteTrack?: (track: number) => void;
  /** 右键菜单「在上方 / 下方插入轨道」:在 pos 位置插一条空轨道,原来 ≥ pos 的整体下移 */
  onInsertTrack?: (pos: number) => void;
  /** 拖标签调顺序:把第 from 条轨道挪到第 to 条的位置(都是 1 起的序号;to 是「挪完之后它排第几」),中间的整体顺移 */
  onReorderTrack?: (from: number, to: number) => void;
  /** 轨道自定义名(双击序列标签改的):key 是 1 起的轨道号;没有的显示默认「序列n」 */
  trackNames?: Record<number, string>;
  /** 双击标签改名后写回:name 已 trim;空串 = 清掉自定义名、回到默认 */
  onRenameTrack?: (track: number, name: string) => void;
  /** 导入的视频,每条一个「视频序列」:name 由 App 给(视频序列1、视频序列2…),offset 默认 0 */
  videoTracks?: { id: string; name: string; src: string; duration: number; offset?: number }[];
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** 边缘拖拽判定区(px):落在色块左右这个范围内 = 改起止,否则整块平移 */
const EDGE_PX = 8;
/** 卡片最短时长(秒) */
const MIN_DUR = 0.3;
/** 色块内一行文字的高度(px),必须和 TimelineBar.css 里 .tlb-card-text 的 line-height 一致 */
const CARD_LINE_H = 16;
/** 色块文字的上下内边距合计(px),和 .tlb-card-text 的 padding 一致 */
const CARD_PAD_V = 4;
/** 顶部时间标尺的高度(px):标尺钉在轨道区顶部,播放头三角把手就落在它上面 */
const RULER_H = 22;
/** 横向缩放范围 */
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

/** 重叠的卡片自动分行:贪心装进第一条放得下的轨道 */
function assignLanes(cards: OverlayCard[]): Map<string, number> {
  const laneEnds: number[] = [];
  const map = new Map<string, number>();
  const sorted = [...cards].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    let lane = laneEnds.findIndex((end) => end <= c.start + 0.001);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = c.end;
    map.set(c.id, lane);
  }
  return map;
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

/**
 * 底部视频时间线:当前/总时长/显示数 + 缩放 + 多行卡片轨道 + 播放头。
 * 剪映式擦洗:轨道空白处按下 = 跳到该处,按住左右拖 = 白色竖线跟手。
 * 缩放:「− / +」按钮或 ⌘+滚轮(触控板捏合),拉宽后拖边缘改时间更好下手。
 * 色块整体拖动 = 平移时间;拖左右边缘 = 改出现/消失;点一下 = 选中并跳过去。
 */
export function TimelineBar({
  duration,
  t,
  cards,
  selectedId,
  onSeek,
  onSelect,
  onTimes,
  trackCount,
  onAddTrack,
  onDropEffect,
  onTrack,
  onDeleteTrack,
  onInsertTrack,
  onReorderTrack,
  trackNames,
  onRenameTrack,
  videoTracks,
}: TimelineBarProps) {
  // 右键菜单:在哪条轨道上按的、弹在哪(视口坐标)
  const [menu, setMenu] = useState<{ x: number; y: number; track: number } | null>(null);
  // 双击序列标签改名:正在改哪条、输入框里的草稿
  const [editing, setEditing] = useState<{ track: number; value: string } | null>(null);
  const beginRename = (track: number) => {
    if (!onRenameTrack) return;
    setMenu(null);
    setEditing({ track, value: trackNames?.[track] ?? "" });
  };
  const commitRename = () => {
    if (!editing) return;
    const { track, value } = editing;
    setEditing(null);
    const clean = value.trim();
    // 没改就别记一步撤销
    if (clean === (trackNames?.[track] ?? "")) return;
    onRenameTrack?.(track, clean);
  };
  const renameInputRef = useRef<HTMLInputElement>(null);
  /**
   * 点输入框以外的任何地方 = 提交并退出改名。
   * 光靠 onBlur 不够:时间轴上擦洗、拖色块、拖标签、拖抓手这些 pointerdown 都 preventDefault 了,
   * 浏览器就不会把焦点从输入框挪走,blur 永远不来,输入框一直挂着。
   * 所以改名期间在 window 上用捕获阶段盯 pointerdown,目标不在输入框里就当作提交。
   */
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const el = renameInputRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      commitRename();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", commitRename);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", commitRename);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, trackNames]);
  const openTrackMenu = (e: React.MouseEvent, track: number) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, track });
  };
  const dur = Math.max(duration, 0.001);
  /** 滚动容器(视口) */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 实际内容(宽 = zoom × 视口):所有百分比定位都相对它 */
  const innerRef = useRef<HTMLDivElement>(null);
  /** 轨道包裹层，用于计算拖拽命中相对位置 */
  const bandsRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // 缓放后要恢复的锚点:{frac: 锚点在内容中的比例, vx: 锚点距视口左缘 px}
  const anchorRef = useRef<{ frac: number; vx: number } | null>(null);
  
  // 行高三档按「色块里能放几行文字」定:小 = 1 行、中 = 2 行、大 = 3 行(记住偏好)。
  // 以前是写死的 16/22/32px,「大」也只够一行字,用户反馈太小。现在从文字行高倒推:
  // 色块高 = 行数 × 文字行高(16px,见 .tlb-card-text 的 line-height) + 上下内边距 4px;
  // 行高(相邻色块的间距)= 色块高 + 5px 间隙。文字的排法由 .tlb-card[data-lines] 的 CSS 决定。
  const [laneLines, setLaneLines] = useState<1 | 2 | 3>(() => {
    const v = Number(localStorage.getItem("tlbLaneLines"));
    // 默认「中」(两行):效果名 + 摘要都看得见;没存过偏好就用它
    return v === 1 || v === 2 || v === 3 ? v : 2;
  });
  const laneH = laneLines * CARD_LINE_H + CARD_PAD_V + 5;
  // 单条序列缩回「小」:行高在「中/大」时,序列标签下面有个 ︿ 按钮,点了这条序列按 1 行显示,再点 ﹀ 恢复。
  // 只存在本组件状态里(不落盘):序列号会随插入/删除/换序变,shiftCollapsed 跟着搬。
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const linesFor = (track: number): 1 | 2 | 3 => (collapsed.has(track) ? 1 : laneLines);
  const laneHFor = (track: number) => (collapsed.has(track) ? CARD_LINE_H + CARD_PAD_V + 5 : laneH);
  const trackHeight = (track: number, lCounts: Map<number, number>) => (lCounts.get(track) ?? 1) * laneHFor(track);
  const toggleCollapse = (track: number) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(track)) n.delete(track);
      else n.add(track);
      return n;
    });
  /** 序列号变动时把折叠集合按同一套映射搬家:f(旧号) → 新号,返回 <1 = 这条序列没了 */
  const shiftCollapsed = (f: (t: number) => number) =>
    setCollapsed((s) => {
      const n = new Set<number>();
      s.forEach((t) => {
        const nt = f(t);
        if (nt >= 1) n.add(nt);
      });
      return n;
    });
  // 一条序列里不许两张卡时间重叠(一层 = 一条序列)。拖卡 / 拖效果落到被占用的时段 = 不能落:
  // 这条带画成「禁止」样式,松手后卡回原位、效果不加。blockedTrack = 正被拒的那条序列
  const [blockedTrack, setBlockedTrack] = useState<number | null>(null);
  // 松手时要立刻知道「现在是不是被拒」,state 在闭包里是旧的,同步一份到 ref
  const blockedRef = useRef<number | null>(null);
  const setBlocked = (v: number | null) => {
    blockedRef.current = v;
    setBlockedTrack(v);
  };
  /** track 上除 exceptId 之外的卡 */
  const othersOn = (track: number, exceptId?: string) =>
    cards.filter((c) => c.id !== exceptId && trackOf(c) === track);
  /** [s, en) 放在 track 上会不会和别的卡撞上(首尾相接不算) */
  const fitsOn = (track: number, s: number, en: number, exceptId?: string) =>
    !othersOn(track, exceptId).some((c) => c.start < en - 1e-6 && c.end > s + 1e-6);
  /** 包住 [s, en) 的空档边界:lo = 左边最近一张的结束,hi = 右边最近一张的开始(没有 = Infinity) */
  const gapAround = (track: number, s: number, en: number, exceptId?: string) => {
    let lo = 0;
    let hi = Infinity;
    for (const c of othersOn(track, exceptId)) {
      if (c.end <= s + 1e-6) lo = Math.max(lo, c.end);
      if (c.start >= en - 1e-6) hi = Math.min(hi, c.start);
    }
    return { lo, hi };
  };
  // 轨道区面板高度
  const [trackH, setTrackH] = useState(() => {
    const v = Number(localStorage.getItem("tlbTrackH"));
    // 内嵌浏览器面板刚挂载时 innerHeight 可能是 0(视口还没量出来):这时 0.7×0 = 0,
    // 存过的值会被判成「超上限」、默认值也算成 0,轨道区就整个塌没 —— 视口没量到就按 900 算
    const vh = window.innerHeight > 200 ? window.innerHeight : 900;
    return Number.isFinite(v) && v >= 96 && v <= vh * 0.7 ? v : Math.max(96, Math.round(vh * 0.32));
  });
  // 拖标签调顺序状态
  const [reorderState, setReorderState] = useState<{ from: number; k: number } | null>(null);
  /**
   * 「序列」标签独立成左侧一列(.tlb-gutter),不再叠在色块上:
   * 以前标签 sticky 在每条带的左上角、盖住 0 秒处的卡。现在滚动容器里是一行两列 ——
   * 左列标签(sticky,横向滚动时不动),右列才是内容层 .tlb-inner。
   * 内容层的宽度不能再写百分比(父级是按内容撑开的 flex 行,百分比会算不出来),
   * 改成按视口实测宽度算 px:innerW = zoom × (视口宽 − 标签列宽)。
   */
  const [viewW, setViewW] = useState(0);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const measure = () => {
      setViewW(sc.clientWidth);
      // 视口刚量出来时顺手把塌成 0 的面板高度扶回来(见 trackH 的初始化注释)
      setTrackH((h) => (h < 96 ? Math.max(96, Math.round(window.innerHeight * 0.32)) : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);
  // 平移状态
  const [panning, setPanning] = useState(false);

  const [resizing, setResizing] = useState(false);
  const [hoveredTrack, setHoveredTrack] = useState<number | null>(null);

  const [insertPos, setInsertPos] = useState<number | null>(null);
  const insertPosRef = useRef<number | null>(null);

  const setInsertPosBoth = (p: number | null) => {
    setInsertPos(p);
    insertPosRef.current = p;
  };

  /**
   * 拖动中的色块:脱离所在的轨道带,按鼠标位置浮动渲染(见渲染末尾的 is-dragging)。
   * 以前拖动时色块一直留在原带里:横向跟手,纵向却要等松手调 onTrack 才换带;
   * 而且 start 一变 assignLanes 就重算,色块还会在带内上下跳行、别的卡也跟着挪 ——
   * 看起来就是「色块和鼠标分离」。现在纵向直接跟鼠标,松手才真正落带。
   */
  const [drag, setDrag] = useState<{ id: string; top: number; track: number } | null>(null);
  /** 拖动期间冻结的分行结果:别的卡不因为被拖的卡 start 在变而重新排行 */
  const frozenRef = useRef<{ lanes: Map<string, number>; laneCounts: Map<number, number> } | null>(
    null,
  );

  const count = Math.max(1, trackCount ?? 1);
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);
  
  /**
   * 标签列宽:按最长的那个标签估(等宽 11px 字:中日韩字约 11px、其余约 7px)+ 左右各 6px。
   * 默认「序列n」= 22 + 7×位数;自定义名最多按 12 个字算,再长的在格子里省略号。
   */
  const [gutterW, setGutterW] = useState(() => {
    const widthOf = (s: string) =>
      [...s.slice(0, 12)].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? 11 : 7), 0);
    let w = widthOf(trackLabel(count));
    for (let i = 1; i <= count; i++) w = Math.max(w, widthOf(trackLabel(i, trackNames)));
    if (videoTracks) {
      for (const vt of videoTracks) w = Math.max(w, widthOf(`🎞 ${vt.name}`));
    }
    return Math.min(160, Math.max(40, w + 14));
  });

  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      if (!canvasCtxRef.current) {
        canvasCtxRef.current = document.createElement("canvas").getContext("2d");
      }
      const ctx = canvasCtxRef.current;
      if (!ctx) return;
      
      const cell = document.querySelector(".tlb-gutter-cell");
      let font = "600 11px monospace";
      if (cell) {
        const comp = getComputedStyle(cell);
        if (comp.fontWeight && comp.fontSize && comp.fontFamily) {
          font = `${comp.fontWeight} ${comp.fontSize} ${comp.fontFamily}`;
        }
      }
      ctx.font = font;
      
      let maxW = 0;
      for (let i = 1; i <= count; i++) {
        maxW = Math.max(maxW, ctx.measureText(trackLabel(i, trackNames)).width);
      }
      if (videoTracks) {
        for (const vt of videoTracks) {
          maxW = Math.max(maxW, ctx.measureText(`🎞 ${vt.name}`).width);
        }
      }
      // 标签下面那颗「收起 / 展开」胶囊按钮也要放得下:它有自己的字号和 5px 内边距 + 1px 边框,
      // 只按标签文字量的话,「序列1」这种短标签会把列宽压到 43px,按钮被裁掉一截。
      // 有按钮就按它实际的字体量,没渲染出来(行高「小」时不显示)就按标签字体估。
      const fold = document.querySelector(".tlb-gutter-fold");
      if (fold) {
        const fc = getComputedStyle(fold);
        ctx.font = `${fc.fontWeight} ${fc.fontSize} ${fc.fontFamily}`;
      }
      const foldW =
        Math.max(ctx.measureText("收起").width, ctx.measureText("展开").width) + 10 + 2;
      maxW = Math.max(maxW, foldW);
      const w = Math.round(Math.min(Math.max(maxW + 14, 40), 160));
      setGutterW(w);
    };

    measure();
    if (document.fonts) {
      document.fonts.ready.then(measure);
    }
    
    return () => {
      cancelled = true;
    };
  }, [count, trackNames, videoTracks]);
  /** 内容层宽度(px):zoom × (视口 − 标签列);视口还没量到时先按 0,下一帧就有 */
  const innerW = Math.max(0, Math.round(zoom * (viewW - gutterW)));

  /**
   * 顶部导航条(Premiere 式):一条代表整段时长的槽,滑块 = 此刻看得见的那一段。
   * 拖滑块中间 = 平移;拖两端 = 缩放(另一端不动);点槽的空白处 = 把滑块中心挪过去;双击滑块 = 复位 1×。
   * 1× 时滑块占满整条槽 —— 这时也能捏两端放大,不用再去找加减号。
   */
  const [scrollLeft, setScrollLeft] = useState(0);
  const navRef = useRef<HTMLDivElement>(null);
  /** 拖两端缩放后要落到的 fracStart:zoom 变了内容层才有新宽度,得等布局完再定 scrollLeft */
  const navPendingRef = useRef<number | null>(null);
  const fracLen = Math.min(1, 1 / zoom);
  const fracStart = innerW > 0 ? Math.min(Math.max(scrollLeft / innerW, 0), 1 - fracLen) : 0;
  /**
   * 全局播放头:画在 .tlb-body(导航条 + 轨道区的定位容器)上,从导航条一直贯穿到轨道区底部,
   * 像剪辑软件那样。x 按滚动位置换算成视口坐标;滚出可见范围就不画。
   */
  const headFrac = Math.min(Math.max(t, 0), dur) / dur;
  const headX = gutterW + headFrac * innerW - scrollLeft;
  const headVisible = innerW > 0 && headX >= gutterW - 1 && headX <= viewW + 1;

  /**
   * 顶部时间标尺(在滚动内容里、纵向 sticky):刻度间隔按每秒像素数挑,保证相邻标签至少隔 80px;
   * 大刻度带时间文字,中间再补一格小刻度。点/拖标尺 = 定位当前帧(事件冒泡到 .tlb-inner 的擦洗)。
   */
  const pxPerSec = innerW > 0 ? innerW / dur : 0;
  const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const tickStep = TICK_STEPS.find((s) => s * pxPerSec >= 80) ?? 600;
  const ticks: number[] = [];
  for (let s = 0; s <= dur + 1e-6; s += tickStep) ticks.push(Math.round(s * 1000) / 1000);
  const fmtTick = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return tickStep < 1 ? `${m}:${sec.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.round(sec)).padStart(2, "0")}`;
  };
  const startNavDrag = (e: React.PointerEvent, mode: "move" | "l" | "r") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const nav = navRef.current;
    const sc = scrollRef.current;
    if (!nav || !sc) return;
    const navW = nav.getBoundingClientRect().width || 1;
    const x0 = e.clientX;
    const s0 = fracStart;
    const l0 = fracLen;
    const sl0 = sc.scrollLeft;
    const minLen = 1 / ZOOM_MAX;
    const onMove = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / navW;
      if (mode === "move") {
        sc.scrollLeft = sl0 + d * innerW;
        return;
      }
      let ns = s0;
      let nl = l0;
      if (mode === "l") {
        const right = s0 + l0;
        ns = Math.min(Math.max(s0 + d, 0), right - minLen);
        nl = right - ns;
      } else {
        nl = Math.min(Math.max(l0 + d, minLen), 1 - s0);
      }
      navPendingRef.current = ns;
      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 1 / nl)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const { lanes, laneCounts } = useMemo(() => {
    const lMap = new Map<string, number>();
    const cMap = new Map<number, number>();
    for (let i = 1; i <= count; i++) {
      const trackCards = cards.filter((c) => trackOf(c) === i);
      const tMap = assignLanes(trackCards);
      let maxLane = 0;
      tMap.forEach((lane, id) => {
        lMap.set(id, lane);
        maxLane = Math.max(maxLane, lane + 1);
      });
      cMap.set(i, Math.max(1, maxLane));
    }
    return { lanes: lMap, laneCounts: cMap };
  }, [cards, count]);
  // 渲染和纵向落带判定用的分行:拖动中用冻结的那份,别的时候用实时的
  const view = drag && frozenRef.current ? frozenRef.current : { lanes, laneCounts };

  const headPct = (Math.min(Math.max(t, 0), dur) / dur) * 100;

  /** 顶边抓手:上下拖调整时间轴面板高度 */
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    const y0 = e.clientY;
    const h0 = trackH;
    
    const calc = (y: number) => {
      const maxH = window.innerHeight * 0.7;
      return Math.round(Math.max(96, Math.min(maxH, h0 + (y0 - y))));
    };
    const onMove = (ev: PointerEvent) => setTrackH(calc(ev.clientY));
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      localStorage.setItem("tlbTrackH", String(calc(ev.clientY)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 缩放并保持锚点位置不跳(anchorX = 视口内的 clientX;缺省用视口中心) */
  const zoomTo = (next: number, anchorX?: number) => {
    const sc = scrollRef.current;
    const inner = innerRef.current;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 4) / 4));
    if (!sc || !inner || z === zoom) return;
    const rect = sc.getBoundingClientRect();
    const vx = anchorX != null ? anchorX - rect.left : rect.width / 2;
    // 滚动内容里内容层从 gutterW 起,锚点换算成内容层内的比例时要先扣掉标签列
    const frac = (sc.scrollLeft + vx - gutterW) / inner.getBoundingClientRect().width;
    anchorRef.current = { frac, vx };
    setZoom(z);
  };

  // 缩放渲染完成后恢复锚点的滚动位置
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const inner = innerRef.current;
    if (!sc || !inner) return;
    // 导航条拖两端缩放:按拖的时候算好的起点比例落 scrollLeft
    const p = navPendingRef.current;
    if (p !== null) {
      navPendingRef.current = null;
      sc.scrollLeft = p * inner.getBoundingClientRect().width;
      setScrollLeft(sc.scrollLeft);
      return;
    }
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    sc.scrollLeft = a.frac * inner.getBoundingClientRect().width + gutterW - a.vx;
    setScrollLeft(sc.scrollLeft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // ⌘/ctrl + 滚轮(触控板捏合)= 缩放。React 的 onWheel 是 passive,挡不住页面缩放,挂原生监听
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoom - Math.sign(e.deltaY) * 0.5, e.clientX);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  /** 剪映式擦洗 / 横向平移 */
  const startScrub = (e: React.PointerEvent) => {
    const isPan = e.button === 1 || (e.button === 0 && e.altKey);
    const inner = innerRef.current;
    const sc = scrollRef.current;
    if (!inner || !sc) return;

    if (isPan) {
      e.preventDefault();
      setPanning(true);
      const x0 = e.clientX;
      const sl0 = sc.scrollLeft;
      const onMove = (ev: PointerEvent) => {
        sc.scrollLeft = sl0 - (ev.clientX - x0);
      };
      const onUp = () => {
        setPanning(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();
    const seekAt = (clientX: number) => {
      const rect = inner.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(round2(ratio * dur));
    };
    seekAt(e.clientX);
    const onMove = (ev: PointerEvent) => seekAt(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 拖标签调顺序 */
  const startReorder = (e: React.PointerEvent, track: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    
    let currentK = track;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved && (Math.abs(ev.clientX - x0) > 3 || Math.abs(ev.clientY - y0) > 3)) {
        moved = true;
      }
      if (!moved) return;
      if (!bandsRef.current) return;
      const bandsRect = bandsRef.current.getBoundingClientRect();
      const y = ev.clientY - bandsRect.top;
      
      let acc = 0;
      let k = count + 1;
      for (let i = 1; i <= count; i++) {
        const h = trackHeight(i, view.laneCounts);
        const mid = acc + h / 2;
        if (y < mid) {
          k = i;
          break;
        }
        acc += h;
      }
      currentK = k;
      setReorderState({ from: track, k });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      
      setReorderState(null);
      if (moved) {
        const to = currentK > track ? currentK - 1 : currentK;
        if (to !== track) {
          {
            // 折叠集合跟着换序搬家(和 App 的 handleReorderTrack 同一套映射)
            const arr = Array.from({ length: count }, (_, i) => i + 1);
            const [moved] = arr.splice(track - 1, 1);
            arr.splice(to - 1, 0, moved);
            shiftCollapsed((t) => arr.indexOf(t) + 1);
          }
          onReorderTrack?.(track, to);
        }
      }
    };
    
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const calcInsertion = (y: number, lCounts: Map<number, number>) => {
    const GAP_PX = 5;
    let acc = 0;
    const accs = [0];
    for (let i = 1; i <= count; i++) {
      acc += trackHeight(i, lCounts);
      accs.push(acc);
    }
    
    const videoH = (videoTracks?.length ?? 0) * laneH;
    
    if (y >= accs[count] - GAP_PX && y <= accs[count] + GAP_PX) {
      return { pos: count + 1, acc: accs[count] };
    }
    if (y >= accs[count] + videoH) {
      return { pos: count + 1, acc: accs[count] + videoH };
    }
    if (y > accs[count] + GAP_PX && y < accs[count] + videoH) {
      return null;
    }
    
    for (let i = 1; i <= count - 1; i++) {
      if (Math.abs(y - accs[i]) <= GAP_PX) return { pos: i + 1, acc: accs[i] };
    }
    
    if (y <= GAP_PX) return { pos: 1, acc: 0 };
    return null;
  };

  const getTrackAtY = (y: number, lCounts: Map<number, number>) => {
    let acc = 0;
    for (let i = 1; i <= count; i++) {
      const h = trackHeight(i, lCounts);
      if (y < acc + h) return i;
      acc += h;
    }
    const videoH = (videoTracks?.length ?? 0) * laneH;
    if (y < acc + videoH) return null;
    return count;
  };

  const startDrag = (e: React.PointerEvent, card: OverlayCard) => {
    if (e.button !== 0) return;
    const inner = innerRef.current;
    if (!inner) return;
    e.preventDefault();
    e.stopPropagation(); // 别触发轨道擦洗
    onSelect(card.id);

    const rect = inner.getBoundingClientRect();
    const pxToSec = dur / rect.width;
    const blockEl = e.currentTarget as HTMLElement;
    const b = blockEl.getBoundingClientRect();
    // 判定模式:左边缘 / 右边缘 / 整块平移(窄色块按 1/3 宽收缩边缘区,避免误判)
    const edge = Math.min(EDGE_PX, b.width / 3);
    const mode =
      e.clientX - b.left <= edge ? "start" : b.right - e.clientX <= edge ? "end" : "move";
    const s0 = card.start;
    const e0 = card.end;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let movedX = false;
    let movedY = false;
    
    const startTrack = trackOf(card);
    let currentTargetTrack = startTrack;
    setHoveredTrack(startTrack);
    // 纵向跟手的基准:色块顶边相对 V 带父容器的位置;带高在拖动期间冻结,所以这些数字全程有效
    const bandsRect = bandsRef.current?.getBoundingClientRect() ?? null;
    const blockTop0 = bandsRect ? b.top - bandsRect.top : 0;
    const blockH = laneHFor(startTrack) - 5;
    const frozen = { lanes, laneCounts };
    frozenRef.current = frozen;

    // 磁吸对齐:其他卡的起止 + 播放头 + 0 点;10px 内自动吸附(按 Alt 拖 = 关磁吸)
    const targets: number[] = [0, t];
    for (const c of cards) if (c.id !== card.id) targets.push(c.start, c.end);
    const snapTol = 10 * pxToSec;
    const snap = (v: number, disabled: boolean) => {
      if (disabled) return v;
      let best = v;
      let bd = snapTol;
      for (const s of targets) {
        const dd = Math.abs(v - s);
        if (dd < bd) {
          bd = dd;
          best = s;
        }
      }
      return best;
    };

    // 卡当前的起止(每次写回都同步),横向夹紧和落带判定都看它
    let curS = s0;
    let curE = e0;
    const writeTimes = (s: number, en: number) => {
      curS = s;
      curE = en;
      onTimes(card.id, s, en);
    };
    // 拖边缘:只能在本序列的空档里伸缩,顶到邻居为止
    const own = gapAround(startTrack, s0, e0, card.id);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (Math.abs(dx) > 3) movedX = true;
      if (Math.abs(dy) > 3) movedY = true;
      if (!movedX && !movedY) return;
      
      const noSnap = ev.altKey;
      // 横向处理。主要在上下换轨道时,手抖出来的几像素横向位移不该改时间 ——
      // 否则磁吸会把色块横向弹到别的卡边缘去,鼠标还在原地
      if (movedX && (mode !== "move" || Math.abs(dx) > 4)) {
        const d = dx * pxToSec;
        if (mode === "move") {
          const len = e0 - s0;
          let s = Math.max(0, s0 + d);
          const sSnap = snap(s, noSnap);
          const eSnap = snap(s + len, noSnap);
          if (Math.abs(eSnap - (s + len)) < Math.abs(sSnap - s)) s = Math.max(0, eSnap - len);
          else s = sSnap;
          // 目标序列已定(本序列或已确认能落的别的序列):只能在当前所在的空档里滑,顶到邻居就停,
          // 不会「跳」过一张卡。目标还没定(悬在被拒的序列上)就先放开横向,等它滑到空档再判
          if (currentTargetTrack > 0) {
            const { lo, hi } = gapAround(currentTargetTrack, curS, curE, card.id);
            s = Math.min(Math.max(s, lo), Math.max(lo, hi - len));
          }
          writeTimes(round2(s), round2(s + len));
        } else if (mode === "start") {
          const s = Math.max(own.lo, snap(Math.max(0, s0 + d), noSnap));
          writeTimes(round2(Math.min(s, e0 - MIN_DUR)), e0);
        } else {
          const en = Math.min(own.hi, snap(e0 + d, noSnap));
          writeTimes(s0, round2(Math.max(en, s0 + MIN_DUR)));
        }
      }

      // 纵向处理:鼠标落在哪条带就是目标轨道(带高用冻结的分行算),色块顶边跟着鼠标走
      if (movedY && mode === "move" && bandsRect) {
        const y = ev.clientY - bandsRect.top;
        
        const ins = calcInsertion(y, frozen.laneCounts);
        setInsertPosBoth(ins?.pos ?? null);
        
        if (ins) {
          // 落在两条序列之间 = 新建序列,永远放得下
          setHoveredTrack(null);
          setBlocked(null);
          currentTargetTrack = -1; // invalid
        } else {
          const targetT = getTrackAtY(y, frozen.laneCounts);
          if (targetT === null) {
            currentTargetTrack = -1;
            setHoveredTrack(null);
            setBlocked(null);
          } else if (fitsOn(targetT, curS, curE, card.id)) {
            if (targetT !== currentTargetTrack) {
              currentTargetTrack = targetT;
              setHoveredTrack(targetT);
            }
            setBlocked(null);
          } else {
            // 这条序列在这个时段已经有卡:不能落。松手会回原位;横向再滑到空档就又能落
            currentTargetTrack = -1;
            setHoveredTrack(null);
            setBlocked(targetT);
          }
        }

        const maxTop = Math.max(0, bandsRect.height - blockH);
        setDrag({
          id: card.id,
          top: Math.min(maxTop, Math.max(0, blockTop0 + dy)),
          track: ins ? -1 : currentTargetTrack,
        });
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      
      const finalPos = insertPosRef.current;
      const wasBlocked = blockedRef.current !== null;

      setHoveredTrack(null);
      setBlocked(null);
      setInsertPosBoth(null);
      setDrag(null);
      frozenRef.current = null;
      // 未发生横向与纵向位移 = 单击跳到开头
      if (!movedX && !movedY) {
        onSeek(card.start + 0.01);
      }

      // 只要最终轨道变了且是平移模式，就触发换轨
      if (mode === "move") {
        if (finalPos === null && wasBlocked) {
          // 松手时还悬在被占用的时段上:不换序列、时间也回到拖之前
          if (curS !== s0 || curE !== e0) writeTimes(s0, e0);
          return;
        }
        if (finalPos !== null) {
          {
            // finalPos 是 let,闭包里 TS 不认外面的非空判断,先抄成 const
            const pos = finalPos;
            shiftCollapsed((t) => (t >= pos ? t + 1 : t));
          }
          onTrack?.(card.id, finalPos, { insert: true });
        } else if (currentTargetTrack !== -1 && currentTargetTrack !== startTrack) {
          onTrack?.(card.id, currentTargetTrack);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleBandsDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-overlay-effect")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    
    const bandsRect = bandsRef.current?.getBoundingClientRect();
    if (!bandsRect) return;
    
    const y = e.clientY - bandsRect.top;
    const ins = calcInsertion(y, view.laneCounts);
    setInsertPosBoth(ins?.pos ?? null);

    if (ins) {
      setHoveredTrack(null);
      setBlocked(null);
    } else {
      const targetT = getTrackAtY(y, view.laneCounts);
      // 落点已经在某张卡里面 = 不能落:带画成禁止样式,光标也提示
      if (targetT !== null && !fitsOn(targetT, secAtX(e.clientX), secAtX(e.clientX) + 1e-3)) {
        setHoveredTrack(null);
        setBlocked(targetT);
        e.dataTransfer.dropEffect = "none";
      } else {
        setHoveredTrack(targetT);
        setBlocked(null);
      }
    }
  };
  /** 指针横坐标 → 内容层上的秒 */
  const secAtX = (clientX: number) => {
    const inner = innerRef.current;
    if (!inner) return 0;
    const rect = inner.getBoundingClientRect();
    return Math.max(0, ((clientX - rect.left) / rect.width) * dur);
  };

  const handleBandsDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setHoveredTrack(null);
    setBlocked(null);
    setInsertPosBoth(null);
  };

  const handleBandsDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setHoveredTrack(null);
    setBlocked(null);

    const finalPos = insertPosRef.current;
    setInsertPosBoth(null);
    
    const kind = e.dataTransfer.getData("application/x-overlay-effect");
    if (!kind) return;
    const inner = innerRef.current;
    if (!inner) return;
    const rect = inner.getBoundingClientRect();
    const rawSec = ((e.clientX - rect.left) / rect.width) * dur;
    const start = Math.round(rawSec * 10) / 10;
    
    if (finalPos !== null) {
      {
            // finalPos 是 let,闭包里 TS 不认外面的非空判断,先抄成 const
            const pos = finalPos;
            shiftCollapsed((t) => (t >= pos ? t + 1 : t));
          }
      onDropEffect?.(kind, Math.max(0, start), finalPos, { insert: true });
    } else {
      let targetT: number | null = count;
      const bandsRect = bandsRef.current?.getBoundingClientRect();
      if (bandsRect) {
        targetT = getTrackAtY(e.clientY - bandsRect.top, view.laneCounts);
      }
      if (targetT !== null) {
        const s = Math.max(0, start);
        // 落点在某张卡里面:不加。带上空档右边界,让 App 把新卡的默认时长截到下一张之前
        if (!fitsOn(targetT, s, s + 1e-3)) return;
        const { hi } = gapAround(targetT, s, s + 1e-3);
        onDropEffect?.(kind, s, targetT, Number.isFinite(hi) ? { maxEnd: hi } : undefined);
      }
    }
  };

  return (
    <div className="tlb">
      <div
        className={`tlb-resize ${resizing ? "is-drag" : ""}`}
        onPointerDown={startResize}
        title="上下拖 = 调整时间轴面板高度"
      >
        <span />
      </div>
      {/* 信息条:总时长和「显示 n」已去掉(画面下方操作栏和顶栏 CARDS 各有一份),只留操作按钮 */}
      <div className="tlb-info">
        <button className="tlb-add-track-btn" onClick={() => onAddTrack?.()}>
          <span className="tlb-add-track-text-wide">＋ 添加序列轨道</span>
          <span className="tlb-add-track-text-compact">＋ 轨道</span>
        </button>
        {/* 行高三档:三个按钮常驻(用户明确要求不要轮换按钮),窄窗口下只缩间距不合并 */}
        <span className="tlb-lane-size">
          {([1, 2, 3] as const).map((n) => (
            <button
              key={n}
              className={`tlb-lane-btn ${laneLines === n ? "is-on" : ""}`}
              title={`色块高度 = ${n} 行文字(行高 ${n * CARD_LINE_H + CARD_PAD_V + 5}px);文字始终是效果名 + 一行摘要,垂直居中`}
              onClick={() => {
                setLaneLines(n);
                localStorage.setItem("tlbLaneLines", String(n));
              }}
            >
              {n === 1 ? "小" : n === 2 ? "中" : "大"}
            </button>
          ))}
        </span>
        <span className="tlb-zoom">
          <button
            className="tlb-zoom-btn"
            onClick={() => zoomTo(zoom - 0.5)}
            disabled={zoom <= ZOOM_MIN}
            title="缩小时间轴(⌘+滚轮)"
          >
            −
          </button>
          <span className="tlb-zoom-val">{zoom.toFixed(2).replace(/\.?0+$/, "")}×</span>
          <button
            className="tlb-zoom-btn"
            onClick={() => zoomTo(zoom + 0.5)}
            disabled={zoom >= ZOOM_MAX}
            title="放大时间轴,方便拖拽(⌘+滚轮)"
          >
            +
          </button>
        </span>
        <span className="tlb-keys">
          空格 播放 · ← → ±0.5s · ↑ ↓ 换卡 · ⌘Z 撤销 · Delete 删卡 · 点/拖轨道 跳转
        </span>
      </div>

      {/* 导航条 + 轨道区套一层定位容器:播放头竖线画在这一层,才能从导航条一直贯穿到轨道区底部 */}
      <div className="tlb-body">
      {/* 顶部导航条:滑块 = 可见范围。左边空出标签列的宽度,让它和内容层对齐 */}
      <div className="tlb-nav-row" style={{ paddingLeft: gutterW }}>
        <div
          className="tlb-nav"
          ref={navRef}
          title="可见范围:拖中间平移,拖两端缩放,点空白处跳过去,双击滑块复位"
          onPointerDown={(e) => {
            // 点槽的空白处:把滑块中心挪到点的位置(点在滑块上的事件由滑块自己接)
            if (e.button !== 0 || e.target !== e.currentTarget) return;
            const sc = scrollRef.current;
            const r = e.currentTarget.getBoundingClientRect();
            if (!sc || !r.width) return;
            const f = (e.clientX - r.left) / r.width;
            sc.scrollLeft = (f - fracLen / 2) * innerW;
          }}
        >
          <div
            className="tlb-nav-thumb"
            style={{ left: `${fracStart * 100}%`, width: `${fracLen * 100}%` }}
            onPointerDown={(e) => startNavDrag(e, "move")}
            onDoubleClick={() => {
              navPendingRef.current = 0;
              setZoom(ZOOM_MIN);
            }}
          >
            <span className="tlb-nav-handle is-l" onPointerDown={(e) => startNavDrag(e, "l")} />
            <span className="tlb-nav-handle is-r" onPointerDown={(e) => startNavDrag(e, "r")} />
          </div>
          {/* 导航条上的播放头刻度:按整段时长的比例标,不随缩放/滚动变 */}
          <span className="tlb-nav-head" style={{ left: `${headFrac * 100}%` }} />
        </div>
      </div>

      <div
        className="tlb-track"
        ref={scrollRef}
        style={{ height: trackH }}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div className="tlb-scroller" style={{ width: gutterW + innerW }}>
          {/* 左列:序列标签,sticky 贴在左边,横向滚动时不动;拖它 = 调轨道顺序,右键 = 轨道菜单 */}
          <div className="tlb-gutter" style={{ width: gutterW, paddingTop: RULER_H + 6 }}>
            {Array.from({ length: count }, (_, i) => {
              const track = i + 1;
              const height = trackHeight(track, view.laneCounts);
              return (
                <div
                  key={track}
                  className={`tlb-gutter-cell ${reorderState?.from === track ? "is-reordering" : ""} ${
                    editing?.track === track ? "is-editing" : ""
                  }`}
                  style={{ height }}
                  title={`${trackLabel(track, trackNames)} · 拖动 = 调整顺序;双击 = 改名;右键 = 菜单`}
                  onPointerDown={(e) => {
                    if (editing?.track === track) return; // 正在改名:让输入框自己处理
                    startReorder(e, track);
                  }}
                  onDoubleClick={() => beginRename(track)}
                  onContextMenu={(e) => openTrackMenu(e, track)}
                >
                  {editing?.track === track ? (
                    <input
                      ref={renameInputRef}
                      className="tlb-gutter-input"
                      value={editing.value}
                      maxLength={24}
                      placeholder={`序列${track}`}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setEditing({ track, value: e.target.value })}
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing(null);
                        }
                        // 别让 Delete / 空格 / 方向键这些全局热键把卡删了、把片子播了
                        e.stopPropagation();
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <>
                      <span className="tlb-gutter-name">{trackLabel(track, trackNames)}</span>
                      {/* 行高「中/大」时才有折叠按钮。用文字不用 ︿:细线箭头在 10px 下像个「-」,用户认不出 */}
                      {laneLines > 1 && (
                        <button
                          type="button"
                          className={`tlb-gutter-fold ${collapsed.has(track) ? "is-folded" : ""}`}
                          title={
                            collapsed.has(track)
                              ? "展开:这条序列恢复到当前行高"
                              : "收起:只把这条序列缩到一行(小),其他序列不变"
                          }
                          onPointerDown={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCollapse(track);
                          }}
                        >
                          {collapsed.has(track) ? "展开" : "收起"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            {videoTracks?.map((vt, i) => (
              <div
                key={vt.id}
                className="tlb-gutter-cell tlb-gutter-cell--video"
                style={{
                  height: laneH,
                  ...(i === 0 ? { borderTop: "1px solid var(--hairline-strong)" } : {}),
                }}
                title={`${vt.name} · 只读`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <span className="tlb-gutter-label">🎞 {vt.name}</span>
              </div>
            ))}
          </div>
        <div
          className={`tlb-inner ${panning ? "is-panning" : ""}`}
          ref={innerRef}
          style={{ width: innerW }}
          onPointerDown={startScrub}
        >
          {/* 顶部时间标尺:纵向 sticky 钉在轨道区顶部,横向跟内容一起滚;点/拖它 = 定位当前帧(事件冒泡到 .tlb-inner 的擦洗) */}
          <div className="tlb-timeruler" style={{ height: RULER_H }} title="点/拖 = 定位当前帧">
            {ticks.map((s) => (
              <span
                key={s}
                className={`tlb-tick ${s + tickStep > dur + 1e-6 ? "is-end" : ""}`}
                style={{ left: `${(s / dur) * 100}%` }}
              >
                <b>{fmtTick(s)}</b>
              </span>
            ))}
            {ticks.map((s) =>
              s + tickStep / 2 <= dur + 1e-6 ? (
                <span key={`m${s}`} className="tlb-tick is-minor" style={{ left: `${((s + tickStep / 2) / dur) * 100}%` }} />
              ) : null,
            )}
          </div>
          <div className="tlb-bands" ref={bandsRef}
               onDragOver={handleBandsDragOver}
               onDragLeave={handleBandsDragLeave}
               onDrop={handleBandsDrop}>
            {Array.from({ length: count }, (_, i) => {
              const track = i + 1;
              const lCount = view.laneCounts.get(track) ?? 1;
              const height = lCount * laneHFor(track);
              // 拖动中的那张不在带里画,由下面的浮动层跟着鼠标画
              const trackCards = cards.filter((c) => trackOf(c) === track && c.id !== drag?.id);

              return (
                <div
                  key={track}
                  className={`tlb-band ${hoveredTrack === track ? "is-drag-over" : ""} ${blockedTrack === track ? "is-blocked" : ""} ${reorderState?.from === track ? "is-reordering" : ""}`}
                  style={{ height }}
                  onContextMenu={(e) => openTrackMenu(e, track)}
                >
                  {trackCards.map((c) => (
                    <div
                      key={c.id}
                      className={`tlb-card ${c.id === selectedId ? "is-sel" : ""} ${
                        t >= c.start && t < c.end ? "is-live" : ""
                      }`}
                      data-lines={linesFor(track)}
                      style={{
                        left: `${(c.start / dur) * 100}%`,
                        width: `${((Math.min(c.end, dur) - c.start) / dur) * 100}%`,
                        top: (view.lanes.get(c.id) ?? 0) * laneHFor(track),
                        height: laneHFor(track) - 5,
                        background: kindColor(c.kind),
                      }}
                      title={`${c.kind} ${fmt(c.start)}–${fmt(c.end)}(拖=平移,拖边缘=改起止,Delete=删除)`}
                      onPointerDown={(e) => startDrag(e, c)}
                    >
                      <div className="tlb-card-text">
                        <span className="tlb-card-name">{effectName(c.kind)}</span>
                        <span className="tlb-card-summary">{cardSummary(c)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
            
            {videoTracks?.map((vt, i) => {
              const start = vt.offset ?? 0;
              const end = Math.min(start + vt.duration, dur);
              let filename = vt.src.split("/").pop() || "";
              try {
                filename = decodeURIComponent(filename);
              } catch {
                // ignore
              }
              return (
                <div
                  key={vt.id}
                  className="tlb-band tlb-band--video"
                  style={{
                    height: laneH,
                    ...(i === 0 ? { borderTop: "1px solid var(--hairline-strong)" } : {}),
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  {end > start && (
                    <div
                      className="tlb-video-clip"
                      style={{
                        left: `${(start / dur) * 100}%`,
                        width: `${((end - start) / dur) * 100}%`,
                        height: laneH - 5,
                      }}
                      title={filename}
                    >
                      <span className="tlb-video-clip-text">{filename}</span>
                    </div>
                  )}
                </div>
              );
            })}

            <div className={`tlb-gap-drop ${insertPos === count + 1 ? "is-active" : ""}`}>
              ＋ 拖到这里新建轨道
            </div>
            
            {insertPos !== null && (() => {
              let acc = 0;
              for (let i = 1; i < insertPos; i++) {
                acc += trackHeight(i, view.laneCounts);
              }
              return (
                <div className="tlb-insert-line" style={{ top: acc }}>
                  <span className="tlb-insert-label">新建轨道</span>
                </div>
              );
            })()}
            
            {reorderState !== null && (() => {
              let acc = 0;
              for (let i = 1; i < reorderState.k; i++) {
                acc += trackHeight(i, view.laneCounts);
              }
              return (
                <div className="tlb-reorder-line" style={{ top: acc }}>
                  <span className="tlb-insert-label">移到这里</span>
                </div>
              );
            })()}
            
            {/* 拖动中的色块:浮在所有带之上,纵向跟鼠标、横向跟(已磁吸的)start;松手才真正落带 */}
            {drag &&
              (() => {
                const c = cards.find((x) => x.id === drag.id);
                if (!c) return null;
                return (
                  <div
                    className={`tlb-card is-dragging ${c.id === selectedId ? "is-sel" : ""} ${blockedTrack !== null ? "is-blocked" : ""}`}
                    data-lines={linesFor(trackOf(c))}
                    style={{
                      left: `${(c.start / dur) * 100}%`,
                      width: `${((Math.min(c.end, dur) - c.start) / dur) * 100}%`,
                      top: drag.top,
                      height: laneHFor(trackOf(c)) - 5,
                      background: kindColor(c.kind),
                    }}
                  >
                    <div className="tlb-card-text">
                      <span className="tlb-card-name">{effectName(c.kind)}</span>
                      <span className="tlb-card-summary">{cardSummary(c)}</span>
                    </div>
                  </div>
                );
              })()}
          </div>
          {/* 刻度条:已播进度 */}
          <div className="tlb-ruler">
            <div className="tlb-ruler-fill" style={{ width: `${headPct}%` }} />
          </div>
          {/* 播放头:白色竖线贯穿整条轨道,跟着时间走(拖动由轨道擦洗接管) */}
          <div className="tlb-playhead" style={{ left: `${headPct}%` }}>
            <span className="tlb-ph-head" />
          </div>
        </div>
        </div>
      </div>
      {/* 全局播放头:从顶部标尺贯穿到轨道区底(不穿过底部导航条);顶端的三角把手可以直接拖 */}
      {headVisible && (
        <div className="tlb-playhead-global" style={{ left: headX }}>
          <span className="tlb-ph-mark" onPointerDown={startScrub} title="拖 = 定位当前帧" />
        </div>
      )}
      </div>

      {/* 轨道右键菜单 */}
      {menu &&
        (() => {
          const n = cards.filter((c) => trackOf(c) === menu.track).length;
          const onlyOne = count <= 1;
          return (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              items={[
                {
                  label: "重命名…",
                  onClick: () => beginRename(menu.track),
                  disabled: !onRenameTrack,
                  hint: "也可以双击标签",
                },
                {
                  label: `在 ${trackLabel(menu.track, trackNames)} 上方插入轨道`,
                  onClick: () => {
                    shiftCollapsed((t) => (t >= menu.track ? t + 1 : t));
                    onInsertTrack?.(menu.track);
                  },
                  disabled: !onInsertTrack,
                },
                {
                  label: `在 ${trackLabel(menu.track, trackNames)} 下方插入轨道`,
                  onClick: () => {
                    shiftCollapsed((t) => (t >= menu.track + 1 ? t + 1 : t));
                    onInsertTrack?.(menu.track + 1);
                  },
                  disabled: !onInsertTrack,
                },
                {
                  label: `删除轨道 ${trackLabel(menu.track, trackNames)}`,
                  onClick: () => {
                    // 删除要先经过页内确认(App 里是 async):等它落定、React 重渲染过一帧之后,
                    // 看序列数真少了才搬折叠集合;用户取消了就什么都不动
                    const before = count;
                    const del = menu.track;
                    Promise.resolve(onDeleteTrack?.(del)).then(() =>
                      setTimeout(() => {
                        if (countRef.current < before) shiftCollapsed((t) => (t === del ? 0 : t > del ? t - 1 : t));
                      }, 0),
                    );
                  },
                  danger: true,
                  disabled: onlyOne || !onDeleteTrack,
                  hint: onlyOne ? "至少保留一条" : n ? `含 ${n} 张卡` : undefined,
                },
              ]}
            />
          );
        })()}
    </div>
  );
}
