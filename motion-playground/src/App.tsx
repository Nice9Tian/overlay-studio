import { useEffect, useMemo, useRef, useState } from "react";
import { EFFECTS } from "./effects/registry";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { ParamsPanel } from "./components/ParamsPanel";
import { AiPanel } from "./components/AiPanel";
import { connectMcpExecutor, type EditorApi } from "./ai/mcpExecutor";
import { TimelineBar } from "./components/TimelineBar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { StageControls } from "./components/StageControls";
import { TopBar, FORMS, PALETTES, LEGACY_SKIN_MAP } from "./components/TopBar";
import type { LibrarySelection } from "./library/LibraryTab";
import { HoverPreview } from "./library/HoverPreview";
import { addSrtAsset, addVideoAsset, listSrtAssets, listVideoAssets, srtDuration } from "./library/assets";
import { parseOverlay, trackOf, type OverlayCard, type OverlayDoc } from "./overlay/types";
import { trackLabel, effectName, cardSummary } from "./overlay/cardLabel";
import { parseSrt, type SrtLine } from "./overlay/srt";
import { lintOverlay, mergeLintConfig, type LintConfig, type LintIssue } from "./overlay/lint";
import { uploadErrText } from "./uploadErr";
import lintDefaults from "../lint-rules.default.json";

// 个人阈值(lint-rules.local.json,gitignore):存在就叠加覆盖公共默认
const lintLocalModules = import.meta.glob("../lint-rules.local.json", { eager: true }) as Record<
  string,
  { default: Partial<LintConfig> }
>;
const LINT_CFG = mergeLintConfig(
  lintDefaults as Partial<LintConfig>,
  Object.values(lintLocalModules)[0]?.default,
);
import "./effects/hud/hud.css";
import "./App.css";

/** 新卡默认多长:整段演示类的卡要 15 秒才够看完一轮,其余 5 秒。
    右栏那颗「加到 x:xx,时长 n 秒」按钮和真正的插入逻辑共用这一个数,
    避免文案说 5 秒、插进去却是别的。 */
function addSecFor(kind: string) {
  return ["screen-demo", "cam-pan", "focus-card"].includes(kind) ? 15 : 5;
}

export default function App() {
  // ---- 确认框 ----
  // 内嵌浏览器(Claude 桌面应用的浏览器面板、部分 WebView)会把原生 confirm 自动按取消
  // (实测 3ms 返回 false、不显示任何东西),所有靠 confirm 的守卫都静默失效,
  // 用户看到的是按钮点了没反应。所以用页内确认框(ConfirmDialog)替换 window.confirm。
  const [confirmReq, setConfirmReq] = useState<{ message: string; title?: string } | null>(null);
  const confirmResolver = useRef<((val: boolean) => void) | undefined>(undefined);
  const confirmOpenRef = useRef(false);

  const askConfirm = (message: string, title?: string): Promise<boolean> => {
    return new Promise((resolve) => {
      if (confirmResolver.current) {
        confirmResolver.current(false);
      }
      confirmResolver.current = resolve;
      confirmOpenRef.current = true;
      setConfirmReq({ message, title });
    });
  };

  const handleConfirmClose = (result: boolean) => {
    confirmOpenRef.current = false;
    setConfirmReq(null);
    if (confirmResolver.current) {
      confirmResolver.current(result);
      confirmResolver.current = undefined;
    }
  };

  // 素材库不再是浮层/独立窗口,它是左栏的一个顶级分页 —— 见 LIBRARY-TAB-DESIGN.md
  const [sideTab, setSideTab] = useState<"edit" | "library">("edit");
  // 素材库里鼠标停住的那一项 + 它在屏幕上的矩形,交给 HoverPreview 浮预览(portal 到 body)
  const [hover, setHover] = useState<{ item: LibrarySelection; anchor: DOMRect | null }>({
    item: null,
    anchor: null,
  });
  // 当前在用的字幕稿的名字(素材库据此标「使用中」),随自动存档
  const [srtName, setSrtName] = useState<string | undefined>(undefined);
  // AI 助手:这个页面有没有连上后台的 MCP 桥(/api/mcp/events)。右栏小圆点用
  const [mcpConnected, setMcpConnected] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [showPerson, setShowPerson] = useState(true);
  // 导入的本地视频(object URL):编辑台=停在首帧等播放;效果库=静音循环当背景
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // 视频落盘期间锁住导入按钮。以前这里没有任何状态:传一条几百 MB 的口播要几十秒,
  // 界面全程毫无反应(画面里的视频还先被清掉了),换谁都会再点一次 —— 而同一个素材
  // 传第二遍正好是把后台搞死的那个操作。别的三个上传入口早就有这个锁,只有它漏了。
  const [videoBusy, setVideoBusy] = useState(false);
  // 本地服务在不在。页面是加载进浏览器内存的,服务停了它照样显示、按钮照样能点,
  // 只有真去请求后台才露馅 —— 用户完全没办法自己看出来。所以定时探一下,明着说。
  const [online, setOnline] = useState(true);
  const [videoDur, setVideoDur] = useState(0);
  // 编辑台的视频声音(效果库永远静音)
  const [muted, setMuted] = useState(false);
  // 视频画面缩放:视频自带黑边/比例不满时,放大充满画布(1 = 原始)
  const [videoScale, setVideoScale] = useState(1);
  // 导出透明动效层
  const [exporting, setExporting] = useState(false);
  // 导出进度(每秒轮询 /api/export-status)
  const [exportProg, setExportProg] = useState<{
    stage: string;
    frame: number;
    total: number;
    startedAt: number;
    framesAt: number;
  } | null>(null);

  // ---- 编辑台:时间轴 ----
  const [overlay, setOverlay] = useState<OverlayDoc | null>(null);
  const [curT, setCurT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selCardId, setSelCardId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ---- 多轨道 ----
  const [activeTrack, setActiveTrack] = useState(1);
  const trackCount = useMemo(() => {
    const cardsMax = overlay?.cards.length ? Math.max(...overlay.cards.map(trackOf)) : 1;
    return Math.max(overlay?.tracks ?? 1, cardsMax, 1);
  }, [overlay]);
  useEffect(() => {
    if (activeTrack > trackCount) {
      setActiveTrack(trackCount);
    }
  }, [trackCount, activeTrack]);

  // ---- 学习闭环:记住本次导入的「AI 初选」,导出时连同终选一起落盘 ----
  const originRef = useRef<OverlayDoc | null>(null);

  // ---- 检查器:导入 JSON 时自动跑,只提醒不阻断;忽略标记写进卡片随 JSON 持久化 ----
  const [lintIssues, setLintIssues] = useState<LintIssue[]>([]);
  const [lintCollapsed, setLintCollapsed] = useState(false);

  // ---- 字幕稿(SRT):点句跳转 / 标记覆盖情况 ----
  const [srt, setSrt] = useState<SrtLine[] | null>(null);

  // ---- 自动保存:编排随手存进浏览器,下次打开自动恢复 ----
  const AUTOSAVE_KEY = "overlayStudioAutosave";
  // 「学一下」是这套工具里唯一一个用户发现不了的能力 —— 不主动说,它就等于不存在。
  // 每次导出都会落一份 review-log(初选 vs 终选),但用户不说那三个字就没人去读。
  // 第 1 次和第 3 次导出各提醒一次:第 1 次让他知道有这回事,第 3 次他已经攒够改动了。
  const WELCOME_KEY = "overlayStudioWelcomed";
  const LEARN_TIP_KEY = "overlayStudioLearnTipCount";
  const maybeShowLearnTip = () => {
    let n = 1;
    try {
      n = Number(localStorage.getItem(LEARN_TIP_KEY) || 0) + 1;
      localStorage.setItem(LEARN_TIP_KEY, String(n));
    } catch {
      return; // 隐私模式等禁用 localStorage:不提醒总比每次都弹强
    }
    if (n !== 1 && n !== 3) return;
    setTimeout(() => {
      alert(
        "💡 刚才这份「AI 排的 vs 你改完的」已经存下来了。\n\n" +
          "对 AI 助手说一句「学一下」,它会对比两版、把你改了两次以上的地方问你确认,\n" +
          "写进 skill 目录的《我的偏好.md》和《经验规则.md》。下一期就按你的排法生成。\n\n" +
          "跑几期之后,那份偏好表里的取值就全是你自己的了 —— \n" +
          "出厂的《我的偏好.default.md》是中性的,风格得你自己长出来。",
      );
    }, 400); // 让下载/导出的动作先走完,别打断
  };

  // ---- 外壳外观:两根正交的轴,都挂在 <html> 上 ----
  //   风格 data-form    = 形状骨架(App.css「风格骨架」一节)
  //   配色 data-palette = 颜色取值表(index.css)
  // 只换编辑台外壳,画布/卡片/导出画面完全不受影响。
  const FORM_KEY = "overlayStudioForm";
  const PALETTE_KEY = "overlayStudioPalette";
  const LEGACY_SKIN_KEY = "overlayStudioSkin"; // 单轴时代的旧键,读到就迁移
  // 老用户开机时把旧皮肤 id 拆成两轴;拆完删掉旧键,只会跑这一次
  const restoreLook = () => {
    try {
      const legacy = localStorage.getItem(LEGACY_SKIN_KEY);
      if (legacy !== null) {
        const hit = LEGACY_SKIN_MAP[legacy] ?? { form: "", palette: "" };
        localStorage.setItem(FORM_KEY, hit.form);
        localStorage.setItem(PALETTE_KEY, hit.palette);
        localStorage.removeItem(LEGACY_SKIN_KEY);
        return hit;
      }
      const form = localStorage.getItem(FORM_KEY) ?? "";
      const palette = localStorage.getItem(PALETTE_KEY) ?? "";
      // 存档里是已下架的取值就回落默认
      return {
        form: FORMS.some((f) => f.id === form) ? form : "",
        palette: PALETTES.some((c) => c.id === palette) ? palette : "",
      };
    } catch {
      return { form: "", palette: "" };
    }
  };
  const [look] = useState(restoreLook);
  const [form, setForm] = useState<string>(look.form);
  const [palette, setPalette] = useState<string>(look.palette);
  // 换风格 = 连它的「原配」配色一起换上。
  // 曾经在这里加过「你手动挑过配色就不换」的判断,结果是:只要挑过一次配色,
  // 自动匹配就再也不触发,功能等于不存在。换风格本来就是「整套换掉」的动作,
  // 想要别的配色,换完再点一下配色下拉就行。
  const pickForm = (id: string) => {
    setForm(id);
    setPalette(FORMS.find((f) => f.id === id)?.mate ?? "");
  };

  useEffect(() => {
    const el = document.documentElement;
    if (form) el.dataset.form = form;
    else delete el.dataset.form;
    if (palette) el.dataset.palette = palette;
    else delete el.dataset.palette;
    try {
      localStorage.setItem(FORM_KEY, form);
      localStorage.setItem(PALETTE_KEY, palette);
    } catch {
      // 隐私模式:外观只在本次会话生效
    }
  }, [form, palette]);

  // 首次挂载:恢复上次的编排 + 字幕稿 + 视频
  // 首次打开引导:什么都没有的新用户,先把 60 秒示例端到面前。
  // 空画布 + 一排陌生按钮是最劝退的第一屏;示例一载入,时间轴/画布/参数面板一眼就懂。
  // 只在「没有任何存档」时提一次(WELCOME_KEY 记一次性标记,和「学一下」提示同一套做法)。
  const loadDemoRef = useRef<() => void>(() => {});
  useEffect(() => {
    // 标记要等真正弹过再写:StrictMode 下 effect 会挂载两次,先写标记的话,
    // 第一次写完、第二次看到标记退出,而第一次的定时器又被 cleanup 清掉 —— 谁都弹不出来
    const t = setTimeout(() => {
      void (async () => {
        try {
          if (localStorage.getItem(AUTOSAVE_KEY) || localStorage.getItem(WELCOME_KEY)) return;
          localStorage.setItem(WELCOME_KEY, "1");
        } catch {
          return; // 隐私模式:不打扰
        }
        if (
          await askConfirm(
            "👋 第一次来?\n\n先载入一套 60 秒的示例编排吧 —— 按空格播放,点画布上的卡片改参数,\n时间轴、拖拽、导出都能直接上手试。\n\n(顶栏「🎬 示例」随时能再载入;取消则从空白开始)",
          )
        ) {
          loadDemoRef.current();
        }
      })();
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 心跳:每 10 秒探一次后台(切到别的标签页时不探,省得白费请求)。
  // 回到这个标签页立刻补探一次 —— 「昨天的页面被浏览器恢复了、服务其实没起」
  // 正是最常见的那一幕,这时候第一时间告诉他,别等他点了导入才失败。
  useEffect(() => {
    // 连着两次探不到才算掉线。一次就报会误伤:改 vite.config.ts 会让服务自己重启一下,
    // 导出跑满 CPU 时也可能慢一拍 —— 那几秒里弹一条「服务已停止」比不弹更让人慌。
    let miss = 0;
    const ping = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/export-status", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        miss = 0;
        setOnline(true);
      } catch {
        miss += 1;
        if (miss >= 2) setOnline(false);
      }
    };
    ping();
    const id = window.setInterval(ping, 10000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.overlay?.cards?.length) {
        // 也走一遍 parseOverlay:导入 JSON 会做的字段迁移(letter-glitch 的 speed→flipMs 之类)
        // 和「认不出的卡跳过」,刷新恢复以前全跳过了 —— 升级后旧草稿翻动快 N 倍,就是这个原因。
        const { doc: migrated, dropped } = parseOverlay(saved.overlay);
        if (dropped?.length)
          console.warn("恢复上次编排时跳过了认不出的卡:", dropped.map((d) => `${d.kind}×${d.n}`).join(", "));
        setOverlay(migrated ?? saved.overlay);
        originRef.current = saved.origin ?? null;
        if (Array.isArray(saved.srt) && saved.srt.length) setSrt(saved.srt);
        if (typeof saved.srtName === "string") setSrtName(saved.srtName);
        setSelCardId(saved.overlay.cards[0]?.id ?? null);
      }
      // 视频:落盘过的走 /_media/ 真实路径,刷新后直接恢复,不用重新导入。
      // 先探一下还在不在(用户可能清过 public/_media),不在就当没存过,别留个坏的 <video>。
      if (typeof saved.videoUrl === "string" && saved.videoUrl.startsWith("/_media/")) {
        fetch(saved.videoUrl, { method: "HEAD" })
          .then((r) => r.ok && setVideoUrl(saved.videoUrl))
          .catch(() => {});
      }
    } catch {
      /* 坏数据直接忽略,不打扰 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 落盘过的预览视频自动当全局「口播视频」:运镜卡导出时要烤的,和预览里那条
  // 本来就是同一条。放在 effect 里而不是导入回调里,是因为「先导视频后导编排」
  // 和「先导编排后导视频」两种顺序都要覆盖到。已经手填过的不动。
  // 用户点过「清除」就不再往回填。以前的判断只看 `!overlay.cam`,清除把 cam 置空 →
  // 条件重新成立 → 立刻又填回去,那个「清除」按钮等于一个摆设。
  // 记的是「用户主动清过」这件事本身,不是「哪条视频挂过」:后者在刷新(存档里 cam 已带值,
  // 记号没机会写)和换编排(视频没变、记号还在,新编排永远挂不上)两种情况下都会失效。
  // 换视频 / 导入新编排 / 载入示例时把记号清掉:那是一次新的开始,该挂还得挂。
  const camClearedRef = useRef(false);
  useEffect(() => {
    if (!overlay || overlay.cam || !videoUrl?.startsWith("/_media/")) return;
    if (camClearedRef.current) return;
    setOverlay((o) => (o && !o.cam ? { ...o, cam: videoUrl } : o));
  }, [overlay, videoUrl]);

  // 任何改动后 800ms 自动落盘;删空卡片则清掉存档
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        if (!overlay) return;
        if (overlay.cards.length === 0) {
          localStorage.removeItem(AUTOSAVE_KEY);
          return;
        }
        localStorage.setItem(
          AUTOSAVE_KEY,
          JSON.stringify({
            overlay,
            origin: originRef.current,
            srt,
            srtName,
            // 只存落盘过的真实路径;blob 地址刷新即失效,存了也是坏的
            videoUrl: videoUrl?.startsWith("/_media/") ? videoUrl : undefined,
            savedAt: new Date().toISOString(),
          }),
        );
      } catch {
        /* 存储异常不打扰编辑 */
      }
    }, 800);
    return () => clearTimeout(id);
    // videoUrl 也要在依赖里:少了它,「清除视频」之后不会重新落盘,存档里留着旧地址,
    // 刷新一次视频又回来了 —— 用户看到的就是「清了个寂寞」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, srt, srtName, videoUrl]);

  // ---- 撤销/重做(⌘Z / ⇧⌘Z):存 overlay + 字幕稿 快照 ----
  // 字幕稿也要进快照:「清空」会把它一起清掉,而弹窗承诺了能 ⌘Z 撤销 ——
  // 只记 overlay 的话,撤销回来卡片在、字幕稿没了,自动存档还会顺手把最后一份也覆盖掉。
  type Snap = { overlay: OverlayDoc | null; srt: SrtLine[] | null; srtName?: string };
  const snapRef = useRef<Snap>({ overlay: null, srt: null });
  snapRef.current = { overlay, srt, srtName };
  const undoRef = useRef<Snap[]>([]);
  const redoRef = useRef<Snap[]>([]);
  const lastEditRef = useRef(0);

  /**
   * 每次改动前调用:把当前 overlay 压进撤销栈。
   * 400ms 内的连续改动(拖拽/滑块)合并成同一步;force = 独立操作(加卡/导入/换卡)必压。
   */
  const pushHistory = (force = false) => {
    const now = performance.now();
    const coalesce = !force && now - lastEditRef.current < 400;
    lastEditRef.current = now;
    if (coalesce) return;
    undoRef.current.push(structuredClone(snapRef.current));
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
  };

  const applySnap = (s: Snap) => {
    setOverlay(s.overlay);
    setSrt(s.srt);
    setSrtName(s.srtName);
  };
  const undo = () => {
    if (!undoRef.current.length) return;
    redoRef.current.push(structuredClone(snapRef.current));
    applySnap(undoRef.current.pop()!);
  };
  const redo = () => {
    if (!redoRef.current.length) return;
    undoRef.current.push(structuredClone(snapRef.current));
    applySnap(redoRef.current.pop()!);
  };

  // 编辑台总时长 = max(视频时长, 最后一张卡结束)
  const duration = useMemo(() => {
    const cardsEnd = overlay ? Math.max(...overlay.cards.map((c) => c.end), 0) : 0;
    return Math.max(cardsEnd, videoDur);
  }, [overlay, videoDur]);

  // 导入的视频在时间轴上作为只读的「视频序列n」显示。现在只有一条(videoUrl);
  // 写成数组是给素材库留的口子:以后多条视频素材按同样的形状喂进来就行
  const videoTracks = useMemo(
    () =>
      (videoUrl && videoDur > 0 ? [{ src: videoUrl, duration: videoDur }] : []).map((v, i) => ({
        id: `video-${i + 1}`,
        name: `视频序列${i + 1}`,
        src: v.src,
        duration: v.duration,
      })),
    [videoUrl, videoDur],
  );

  // 编排体检:密度(张/分钟)+ 同屏峰值,顶栏一眼看节奏够不够紧
  const overlayStats = useMemo(() => {
    if (!overlay || overlay.cards.length === 0) return null;
    const evs = overlay.cards
      .flatMap((c) => [[c.start, 1], [c.end, -1]] as [number, number][])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let peak = 0;
    for (const [, d] of evs) {
      cur += d;
      if (cur > peak) peak = cur;
    }
    const span = Math.max(...overlay.cards.map((c) => c.end));
    return { peak, perMin: overlay.cards.length / Math.max(span / 60, 0.1) };
  }, [overlay]);

  // 时钟:有视频跟视频走(rAF 读 currentTime),没视频自走
  useEffect(() => {
    if (!playing) return;
    const v = videoRef.current;
    let raf = 0;
    let last = performance.now();
    // 播放被浏览器拒绝时(极少见)老实退回暂停,不让 UI 假装在播
    if (v) v.play().catch(() => setPlaying(false));
    const tick = (now: number) => {
      if (v) {
        setCurT(v.currentTime);
        if (v.ended || v.currentTime >= duration) {
          setPlaying(false);
          return;
        }
      } else {
        const dt = (now - last) / 1000;
        last = now;
        let done = false;
        setCurT((t) => {
          const nt = t + dt;
          if (nt >= duration) {
            done = true;
            return duration;
          }
          return nt;
        });
        if (done) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (v) v.pause();
    };
  }, [playing, duration]);

  /**
   * 拖播放头之后,把**卡内录屏**也拉回正确位置。
   *
   * 卡内 <video> 是 autoPlay 自己走的,只在挂载时起播 —— 顺着播不会错,
   * 但一旦拖动播放头(卡片重新挂载 / 或本来就在播),它还停在"从挂载算起"的位置,
   * 时间轴显示 45s、画面其实是录屏的头几秒。导出端是按时间轴逐帧对位的,
   * 于是**编辑台里看到的和导出的对不上**(实际碰到过)。
   * 拖完拉一把,两边就一致了。
   */
  const alignCardVideos = (t: number) => {
    document.querySelectorAll<HTMLVideoElement>("video[data-fx-video]").forEach((v) => {
      const d = v.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      const ts = Number(v.dataset.tStart) || 0;
      const clip = Number(v.dataset.fxClip) || 0;
      const rate = Number(v.dataset.fxRate) || 1;
      let want = clip + Math.max(0, t - ts) * rate;
      // 短素材循环:超出的部分按"素材可播长度"取模,和导出端同一套算法
      if (v.hasAttribute("data-fx-loop") && want > d) {
        const span = Math.max(d - clip, 0.1);
        want = clip + ((want - clip) % span);
      }
      const to = Math.min(Math.max(want, 0), d - 0.05);
      if (Math.abs(v.currentTime - to) > 0.2) v.currentTime = to;
    });
  };

  const seek = (t: number) => {
    setCurT(t);
    const v = videoRef.current;
    if (v) v.currentTime = t;
    // 刚跳过去的那一帧卡片可能还没挂上/元数据没到,补一次
    requestAnimationFrame(() => alignCardVideos(t));
    setTimeout(() => alignCardVideos(t), 260);
  };

  // 最新播放状态存 ref,给全局快捷键读(避免每帧重挂监听)
  const curTRef = useRef(0);
  curTRef.current = curT;
  const selCardIdRef = useRef<string | null>(null);
  selCardIdRef.current = selCardId;
  const deleteRef = useRef<(id: string) => void>(() => {});
  const durRef = useRef(0);
  durRef.current = duration;

  // 全局快捷键(永远最高优先级;只在打字输入框里让位):
  // 空格 = 播放/暂停;← → = 快退/快进 0.5s,按住 Shift = 3s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 确认框开着时键盘归它
      if (confirmOpenRef.current) return;
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      const typing =
        el.isContentEditable ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (tag === "INPUT" &&
          ["text", "number", "search"].includes((el as HTMLInputElement).type));
      if (typing) return;

      if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
        // ⌘Z 撤销 / ⇧⌘Z 重做(时间轴改动)
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.code === "Backspace" || e.code === "Delete") && selCardIdRef.current) {
        // Delete = 删除选中的卡
        e.preventDefault();
        deleteRef.current(selCardIdRef.current);
      } else if (e.code === "Space") {
        e.preventDefault();
        if (durRef.current > 0) setPlaying((p) => !p);
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? 3 : 0.5) * (e.code === "ArrowLeft" ? -1 : 1);
        const nt = Math.min(Math.max(0, curTRef.current + step), durRef.current);
        curTRef.current = nt; // 立刻同步,连按不丢步
        setCurT(nt);
        if (videoRef.current) videoRef.current.currentTime = nt;
        requestAnimationFrame(() => alignCardVideos(nt));   // ←/→ 步进也要拉卡内录屏
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleImportJson = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const { doc, error, dropped } = parseOverlay(text);
    if (error || !doc) {
      alert(`❌ JSON 导入失败:${error}`);
      return;
    }
    // 和「载入示例」一样先问一句。这个入口以前不问:拖错一个 JSON 进窗口,当前编排立刻被换掉,
    // 800ms 后自动存档也跟着被盖 —— ⌘Z 能救,刷新一次就救不回了。
    if (overlay?.cards.length && !(await askConfirm("导入这份编排会替换当前编排(可撤销),继续吗?"))) return;
    pushHistory(true);
    camClearedRef.current = false; // 新编排:口播视频该挂还得挂
    setOverlay(doc);
    originRef.current = structuredClone(doc); // AI 初选快照,学习闭环用
    setSelCardId(doc.cards[0]?.id ?? null);
    seek(0);
    setPlaying(false);
    // 自动体检:只提醒不阻断导入。
    // 认不出的卡已经被跳过了,在这儿补一条 error —— 跳过必须看得见,
    // 否则用户只会觉得「导进来好像少了点东西」却说不上少了什么。
    setLintIssues([
      ...(dropped ?? []).map((d) => ({
        level: "error" as const,
        rule: "unknown-kind",
        message: `跳过了 ${d.n} 张「${d.kind}」——  认不出这种卡,其余卡已正常导入。注意:再导出 JSON 时这几张不会带回去,原文件留好`,
      })),
      ...lintOverlay(doc, LINT_CFG, { duration: durRef.current || undefined }),
    ]);
    setLintCollapsed(false);
  };

  /** 检查面板「忽略」:有卡的问题把规则写进那张卡(用户主动决定,随 JSON 保存);
   *  没卡的问题(如 quiet-gap)只从本次列表移除 */
  const handleLintIgnore = (issue: LintIssue) => {
    if (!issue.cardId || !overlay) {
      setLintIssues((arr) => arr.filter((x) => x !== issue));
      return;
    }
    const next: OverlayDoc = {
      ...overlay,
      cards: overlay.cards.map((c) => {
        if (c.id !== issue.cardId || c.lintOff === true) return c;
        const off = Array.from(
          new Set([...(Array.isArray(c.lintOff) ? c.lintOff : []), issue.rule]),
        );
        return { ...c, lintOff: off };
      }),
    };
    pushHistory(true);
    setOverlay(next);
    setLintIssues(lintOverlay(next, LINT_CFG, { duration: durRef.current || undefined }));
  };

  /** 选卡:左栏只列 activeTrack 那条序列的卡,选中谁就把左栏切到谁所在的序列,
      分层之后选中的卡才不会「明明选着却不在列表里」 */
  const selectCard = (id: string | null) => {
    setSelCardId(id);
    const c = id ? overlay?.cards.find((x) => x.id === id) : undefined;
    if (c) setActiveTrack(trackOf(c));
  };

  /** 检查面板「定位」:有卡选中那张卡并跳到进场时刻;只有时间点(空白段)就直接跳时间 */
  const handleLintLocate = (issue: LintIssue) => {
    const c = issue.cardId ? overlay?.cards.find((x) => x.id === issue.cardId) : undefined;
    if (!c && issue.at == null) return;
    if (c) {
      selectCard(c.id);
      seek(c.start + 0.01);
    } else {
      seek(issue.at! + 0.01);
    }
  };

  /** 载入内置演示编排(public/demo/):示例 SRT + 示例 JSON,不需要自己的视频 */
  const handleLoadDemo = async () => {
    if (overlay?.cards.length && !(await askConfirm("载入示例会替换当前编排(可撤销),继续吗?"))) return;
    try {
      const [jsonText, srtText] = await Promise.all([
        fetch("/demo/demo-overlay.json").then((r) => r.text()),
        fetch("/demo/demo.srt").then((r) => r.text()),
      ]);
      const { doc, error, dropped } = parseOverlay(jsonText);
      if (error || !doc) {
        alert(`❌ 示例载入失败:${error}`);
        return;
      }
      // 内置示例是按本档生成的,理论上不该有认不出的卡。真出现了就是发行版做漏了 ——
      // 留这行 warn 当信号,别让示例悄悄少几张卡还没人发现。
      if (dropped?.length)
        console.warn("[示例] 跳过了认不出的卡:", dropped.map((d) => `${d.kind}×${d.n}`).join(", "));
      const lines = parseSrt(srtText);
      pushHistory(true);
      camClearedRef.current = false;
      setSrt(lines.length ? lines : null);
      setSrtName(lines.length ? "demo.srt" : undefined);
      // 示例字幕也登记进素材库的字幕素材,能在那儿看和点句跳转
      if (lines.length) addSrtAsset({ name: "demo.srt", lines });
      setOverlay(doc);
      originRef.current = structuredClone(doc);
      setSelCardId(doc.cards[0]?.id ?? null);
      seek(0);
      setPlaying(false);
      setLintIssues(lintOverlay(doc, LINT_CFG, { duration: durRef.current || undefined }));
      setLintCollapsed(false);
    } catch (e) {
      alert(`❌ 示例载入失败:${e}`);
    }
  };

  /**
   * 把一份字幕用作本期字幕稿。拖 .srt 进窗口、素材库「用作本期字幕稿」(浮层回调 / 独立窗口 bus)都走这里。
   * 已有编排且还没有字幕层卡:自动生成一张常驻双语字幕卡(中文先就位,
   * 英文和 *关键词* 由生成器或你在右栏字幕表里补)
   */
  const applySrtLines = (lines: SrtLine[], name?: string) => {
    setSrt(lines);
    setSrtName(name);
    if (overlay && !overlay.cards.some((c) => c.kind === "caption-track")) {
      const def = EFFECTS.find((e) => e.id === "caption-track");
      const end = Math.ceil(Math.max(...lines.map((l) => l.end)));
      const linesText = lines
        .map(
          (l) =>
            `${l.start.toFixed(2)}|${l.end.toFixed(2)}|${l.text
              .replace(/\|/g, "/")
              .replace(/\s+/g, " ")
              .trim()}`,
        )
        .join("\n");
      // 整段字幕卡从 0 铺到片尾,放在序列 1 会和所有卡叠在一起:单独开一条新序列给它
      const track = trackCount + 1;
      pushHistory(true);
      setOverlay({
        ...overlay,
        tracks: track,
        cards: [
          ...overlay.cards,
          {
            id: `caption-track-${overlay.cards.length + 1}`,
            kind: "caption-track",
            start: 0,
            end,
            track,
            params: { ...(def?.defaults ?? {}), lines: linesText },
          },
        ],
      });
    }
  };

  /** 拖 .srt 进窗口:登记进素材库的字幕素材(素材库窗口里能看到它),再用作本期字幕稿 */
  const handleImportSrt = async (file: File | null) => {
    if (!file) return;
    const lines = parseSrt(await file.text());
    if (!lines.length) {
      alert("❌ SRT 解析失败:没读到任何字幕条。");
      return;
    }
    addSrtAsset({ name: file.name, lines });
    applySrtLines(lines, file.name);
  };

  const handleExportJson = () => {
    if (!overlay) return;
    const blob = new Blob([JSON.stringify(overlay, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "overlay.json";
    a.click();
    URL.revokeObjectURL(a.href);
    // 学习闭环:AI 初选 + 用户终选 一起落盘(失败不打扰导出)
    fetch("/api/review-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        savedAt: new Date().toISOString(),
        origin: originRef.current,
        final: overlay,
      }),
    }).catch(() => {});
    maybeShowLearnTip();
  };

  const handleClearOverlay = async () => {
    // 「清空」清的是这一条编排:卡片 + 字幕稿 + 自动存档。以前只清卡片,字幕稿原样留着,
    // 下一条片子的卡就长在上一条的字幕上 —— 这也是「清除不干净」的一份。
    // 导入的视频不在此列,它有自己的「清除」按钮,不该被这里顺手带走。
    if (!(await askConfirm("清空这条编排?\n\n卡片和字幕稿都会清掉(导入的视频不受影响)。\n可以用 ⌘Z 撤销。")))
      return;
    pushHistory(true);
    localStorage.removeItem(AUTOSAVE_KEY);
    setOverlay(null);
    setSrt(null);
    setSrtName(undefined);
    setPlaying(false);
    setSelCardId(null);
    seek(0);
    setActiveTrack(1);
  };

  loadDemoRef.current = handleLoadDemo;

  // 当前时间点应显示的卡片(编辑台)
  // 提前 0.05s 挂载:进场动画要等 2 帧才触发,提前量让"可见的出现"正卡在 start 上
  const activeCards = useMemo(
    () =>
      overlay
        ? overlay.cards.filter((c) => curT >= c.start - 0.05 && curT < c.end)
        : [],
    [overlay, curT],
  );

  const selCard = overlay?.cards.find((c) => c.id === selCardId) ?? null;
  // 「第几层」只在和它同时出现的卡里数 —— 全局第几张对观众没意义,同屏谁压谁才有
  const layerInfo = (() => {
    if (!overlay || !selCard) return undefined;
    const co = overlay.cards.filter(
      (c) => c.start < selCard.end && c.end > selCard.start,
    );
    return { index: co.findIndex((c) => c.id === selCard.id) + 1, total: co.length };
  })();

  // 编辑选中卡片的参数(编辑台)
  // 一次改一批参数(预设应用走这里):必须用函数式 setOverlay。
  // 以前是 setOverlay({...overlay, …}),循环里连着调 N 次会 N 次都从同一份旧
  // overlay 出发 —— 只有最后一个 key 生效,应用预设看着就像"点了没反应"。
  const patchCardParams = (patch: Record<string, unknown>) => {
    if (!selCardId) return;
    pushHistory();
    setOverlay((o) =>
      o
        ? {
            ...o,
            cards: o.cards.map((c) =>
              c.id === selCardId ? { ...c, params: { ...c.params, ...patch } } : c,
            ),
          }
        : o,
    );
  };
  const handleCardParamChange = (key: string, value: unknown) => {
    patchCardParams({ [key]: value });
  };

  const handleApplyAll = (patch: Record<string, unknown>) => {
    // 不带 force:滑杆连续拖动时每个 onChange 都会进来,400ms 内的合并成一步撤销,
    // 否则拖一次要 ⌘Z 几十下才退得回去(和单卡参数滑杆的做法一致)
    pushHistory();
    setOverlay((o) =>
      o
        ? {
            ...o,
            cards: o.cards.map((c) => ({ ...c, params: { ...c.params, ...patch } })),
          }
        : o,
    );
  };

  const batch = useMemo(() => {
    if (!overlay || overlay.cards.length === 0) return null;
    let scale: number | null = Number(overlay.cards[0].params?.scale) || 1;
    for (const c of overlay.cards) {
      if ((Number(c.params?.scale) || 1) !== scale) {
        scale = null;
        break;
      }
    }
    let speed: number | null = Number(overlay.cards[0].params?.speed) || 1;
    for (const c of overlay.cards) {
      if ((Number(c.params?.speed) || 1) !== speed) {
        speed = null;
        break;
      }
    }
    return { count: overlay.cards.length, scale, speed };
  }, [overlay]);

  // 更换选中卡片的特效类型(时间/落位保留,参数回到新卡默认值)
  const handleCardKindChange = (kind: string) => {
    if (!overlay || !selCardId) return;
    if (!EFFECTS.some((e) => e.id === kind)) return;
    pushHistory(true);
    setOverlay({
      ...overlay,
      cards: overlay.cards.map((c) =>
        c.id === selCardId
          ? {
              ...c,
              kind,
              params: { ...(EFFECTS.find((e) => e.id === kind)?.defaults ?? {}) },
            }
          : c,
      ),
    });
  };

  // 全局底色:一键统一所有卡片的亮/暗(覆盖每张卡的单独设置,可 ⌘Z 撤销)
  const handleGlobalTheme = (theme: "dark" | "light") => {
    if (!overlay) return;
    pushHistory(true);
    setOverlay({
      ...overlay,
      theme,
      cards: overlay.cards.map((c) => ({ ...c, params: { ...c.params, theme } })),
    });
  };

  // 删除卡片(时间轴选中后 Delete / 右栏按钮)
  const handleDeleteCard = (id: string) => {
    pushHistory(true);
    setOverlay((o) =>
      o ? { ...o, cards: o.cards.filter((c) => c.id !== id) } : o,
    );
    setSelCardId((cur) => (cur === id ? null : cur));
  };
  deleteRef.current = handleDeleteCard; // 给全局快捷键(Delete)用

  // 时间轴色块拖拽:直接写回某张卡的起止时间
  const handleCardTimes = (id: string, start: number, end: number) => {
    pushHistory();
    setOverlay((o) =>
      o
        ? {
            ...o,
            cards: o.cards.map((c) => (c.id === id ? { ...c, start, end } : c)),
          }
        : o,
    );
  };

  /**
   * 叠放:把选中卡片在 cards 数组里挪位置。
   * 画布是按数组顺序画的(backdropFirst 只把底幕类提到最前),**排在后面的压在上面**。
   * 只在"和它时间上有重叠"的卡之间挪 —— 跟不同时出现的卡换先后没有任何视觉意义,
   * 白白把数组搅乱。挪不动(上面/下面没有重叠的卡了)就原样返回。
   */
  const handleCardLayer = (dir: "up" | "down" | "top" | "bottom") => {
    if (!overlay || !selCardId) return;
    const cards = overlay.cards.slice();
    const i = cards.findIndex((c) => c.id === selCardId);
    if (i < 0) return;
    const me = cards[i];
    const hit = (c: OverlayCard) => c.id !== me.id && c.start < me.end && c.end > me.start;
    let j = -1;
    if (dir === "up") for (let k = i + 1; k < cards.length; k++) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "top") for (let k = cards.length - 1; k > i; k--) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "down") for (let k = i - 1; k >= 0; k--) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "bottom") for (let k = 0; k < i; k++) { if (hit(cards[k])) { j = k; break; } }
    if (j < 0) return;
    pushHistory();
    cards.splice(i, 1);
    // 往上挪:插到目标后面(删掉自己后目标退了一格,插在 j 正好就是它后面)
    // 往下挪:插到目标前面(目标索引比自己小,删除不影响它,插在 j 就是它前面)
    cards.splice(j, 0, me);
    setOverlay({ ...overlay, cards });
  };

  // 编辑选中卡片的出现/消失时间(秒)
  const handleCardTimeChange = (key: "start" | "end", value: number) => {
    if (!overlay || !selCardId || !Number.isFinite(value)) return;
    pushHistory();
    setOverlay({
      ...overlay,
      cards: overlay.cards.map((c) => {
        if (c.id !== selCardId) return c;
        const next = { ...c, [key]: value };
        return next.end > next.start ? next : c;
      }),
    });
  };

  // 画布直接拖拽/滚轮:给卡片参数打补丁(不触发重放)。画布上只有时间轴的卡,没有卡 id 的拖动不处理
  const handleNudge = (cardId: string | null, patch: Record<string, number>) => {
    if (!cardId) return;
    pushHistory();
    setOverlay((o) =>
      o
        ? {
            ...o,
            cards: o.cards.map((c) =>
              c.id === cardId ? { ...c, params: { ...c.params, ...patch } } : c,
            ),
          }
        : o,
    );
  };

  /** 在 pos 位置腾出一条轨道:原来 ≥ pos 的卡整体下移一位。拖卡插入、拖效果插入、右键插入三处共用 */
  const bumpTracksFrom = (cards: OverlayCard[], pos: number): OverlayCard[] =>
    cards.map((c) => {
      const t = trackOf(c);
      return t >= pos ? { ...c, track: t + 1 } : c;
    });
  /** 一份编排此刻实际的轨道数(和 trackCount 同一口径,但在 setOverlay 回调里要按传入的 o 算) */
  const tracksOf = (o: OverlayDoc) =>
    Math.max(o.tracks ?? 1, o.cards.length ? Math.max(...o.cards.map(trackOf)) : 1, 1);

  /** 建卡入口:时间轴拖放 / 右键插入 / 素材库「加到序列n」共用。params 不传 = 该特效的默认参数。
      不是「插入新序列」时,目标序列在 start 处已经有卡 → 从序列 1 起找第一条在这里空着的,都占了就开新序列;
      新卡的默认时长顶到同序列下一张卡为止(拖放会把空档右边界 maxEnd 一起传来),所以永远不会叠出重叠。 */
  const insertCard = (
    kind: string,
    start: number,
    track: number,
    opts?: { insert?: boolean; params?: Record<string, unknown>; maxEnd?: number },
  ) => {
    const MIN_GAP = 0.5; // 空档比这还窄就当作被占了,免得塞进去一张 0.1 秒的卡
    const baseCards = overlay?.cards ?? [];
    let n = baseCards.length + 1;
    while (baseCards.some((c) => c.id === `card-${n}`)) n++;
    const params = { ...(opts?.params ?? EFFECTS.find((e) => e.id === kind)?.defaults ?? {}) };
    const baseTracks = overlay ? tracksOf(overlay) : 1;
    // 序列 t 在 start 处空着吗?空着就返回这个空档的右边界(右边没卡 = Infinity),占了返回 null
    const gapEndOn = (t: number): number | null => {
      let gapEnd = Infinity;
      for (const c of baseCards) {
        if (trackOf(c) !== t) continue;
        if (c.start <= start && c.end > start) return null;
        if (c.start > start) gapEnd = Math.min(gapEnd, c.start);
      }
      return gapEnd - start < MIN_GAP ? null : gapEnd;
    };
    let placed = track;
    let gapEnd = opts?.maxEnd ?? Infinity;
    if (!opts?.insert) {
      let g = gapEndOn(track);
      if (g === null) {
        placed = baseTracks + 1;
        for (let t = 1; t <= baseTracks; t++) {
          g = gapEndOn(t);
          if (g !== null) {
            placed = t;
            break;
          }
        }
      }
      gapEnd = Math.min(g ?? Infinity, opts?.maxEnd ?? Infinity);
    }
    const card = {
      id: `card-${n}`,
      kind,
      start,
      end: Math.min(start + addSecFor(kind), gapEnd),
      track: placed,
      params,
    };
    const theme =
      params.theme === "light" ? ("light" as const) : params.theme === "dark" ? ("dark" as const) : undefined;
    pushHistory(true);
    setOverlay((o) => {
      if (!o) {
        return { version: 1 as const, theme, cards: [card], tracks: placed > 1 ? placed : undefined };
      }
      let newCards = [...o.cards];
      const currentTracks = Math.max(o.tracks ?? 1, newCards.length ? Math.max(...newCards.map(trackOf)) : 1);
      let newTracks = o.tracks;

      if (opts?.insert) {
        newCards = newCards.map((c) => {
          const t = trackOf(c);
          return t >= placed ? { ...c, track: t + 1 } : c;
        });
        newTracks = currentTracks + 1;
      } else {
        newTracks = placed > 1 ? Math.max(currentTracks, placed) : o.tracks;
      }

      newCards.push(card);
      newCards.sort((a, b) => a.start - b.start);
      return { ...o, cards: newCards, tracks: newTracks };
    });
    setSelCardId(card.id);
    // 新卡可能没落在用户点的那条序列上(被占 → 挪去别处):左栏跟着切过去,加完立刻在列表里看得见
    setActiveTrack(placed);
  };

  /** 素材库「＋ 加到 序列n」:用默认参数插到播放头当前时刻。
      不换分页 —— 新卡在时间轴上直接看得见,想连着加三张也不用来回切 */
  const handleLibraryAddCard = (kind: string) => {
    insertCard(kind, Math.round(curTRef.current * 10) / 10, activeTrack);
  };

  const handleDropEffect = (kind: string, start: number, track: number, opts?: { insert?: boolean; maxEnd?: number }) => {
    insertCard(kind, start, track, opts);
  };

  const handleAddTrack = () => {
    pushHistory(true);
    setOverlay((o) =>
      o ? { ...o, tracks: trackCount + 1 } : { version: 1 as const, cards: [], tracks: 2 }
    );
    setActiveTrack(trackCount + 1);
  };

  const handleCardTrack = (id: string, track: number, opts?: { insert?: boolean }) => {
    pushHistory(true);
    setOverlay((o) => {
      if (!o) return o;
      let newCards = o.cards;
      let currentTracks = Math.max(o.tracks ?? 1, newCards.length ? Math.max(...newCards.map(trackOf)) : 1);
      let newTracks = o.tracks;
      
      if (opts?.insert) {
        newCards = newCards.map(c => {
          if (c.id === id) return { ...c, track: track <= 1 ? undefined : track };
          const t = trackOf(c);
          return t >= track ? { ...c, track: t + 1 } : c;
        });
        newTracks = currentTracks + 1;
      } else {
        newCards = newCards.map(c => (c.id === id ? { ...c, track: track <= 1 ? undefined : track } : c));
      }
      
      return { ...o, cards: newCards, tracks: newTracks };
    });
    if (opts?.insert) {
      setActiveTrack(track);
    }
  };

  /** 右键菜单「在上方 / 下方插入轨道」:pos 位置腾出一条空轨道,原来 ≥ pos 的整体下移 */
  /**
   * 轨道自定义名跟着轨道号走:插入 / 删除 / 换序时轨道号会变,名字要按同一套映射搬家。
   * f(旧号) → 新号;返回 0 或负数 = 这条轨道没了,名字一起丢。
   */
  const remapNames = (
    names: Record<number, string> | undefined,
    f: (t: number) => number,
  ): Record<number, string> | undefined => {
    if (!names) return undefined;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(names)) {
      const nt = f(Number(k));
      if (nt >= 1) out[nt] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  /** 双击序列标签改名:name 已 trim;空串 = 清掉自定义名、回到默认「序列n」 */
  const handleRenameTrack = (track: number, name: string) => {
    const clean = name.trim().slice(0, 24);
    pushHistory(true);
    setOverlay((o) => {
      if (!o) return o;
      const names: Record<number, string> = { ...(o.trackNames ?? {}) };
      if (clean) names[track] = clean;
      else delete names[track];
      return { ...o, trackNames: Object.keys(names).length ? names : undefined };
    });
  };

  const handleInsertTrack = (pos: number) => {
    pushHistory(true);
    setOverlay((o) => {
      if (!o) return { version: 1 as const, cards: [], tracks: Math.max(2, pos) };
      return {
        ...o,
        cards: bumpTracksFrom(o.cards, pos),
        tracks: tracksOf(o) + 1,
        trackNames: remapNames(o.trackNames, (t) => (t >= pos ? t + 1 : t)),
      };
    });
    setActiveTrack(pos);
  };

  /** 拖轨道标签调顺序:把第 from 条轨道挪到第 to 条的位置,中间的整体顺移 */
  const handleReorderTrack = (from: number, to: number) => {
    if (from === to) return;
    pushHistory(true);
    setOverlay((o) => {
      if (!o) return o;
      const tCount = tracksOf(o);
      const arr = Array.from({ length: tCount }, (_, i) => i + 1);
      const [moved] = arr.splice(from - 1, 1);
      arr.splice(to - 1, 0, moved);

      const cards = o.cards.map((c) => {
        const t = trackOf(c);
        if (t > tCount || t < 1) return c;
        const nt = arr.indexOf(t) + 1;
        return { ...c, track: nt <= 1 ? undefined : nt };
      });
      return { ...o, cards, trackNames: remapNames(o.trackNames, (t) => arr.indexOf(t) + 1) };
    });
    setActiveTrack((a) => {
      if (a === from) return to;
      if (a > trackCount || a < 1) return a;
      const arr = Array.from({ length: trackCount }, (_, i) => i + 1);
      const [moved] = arr.splice(from - 1, 1);
      arr.splice(to - 1, 0, moved);
      return arr.indexOf(a) + 1;
    });
  };

  /**
   * 右键菜单「删除轨道 Vn」:轨道上的卡一起删,后面的轨道整体上移一位。
   * 有卡先问一句(页内确认框);⌘Z 可撤销。
   * 顺序不能反:trackCount 是「max(tracks, 卡里最大 track)」的派生值,只减 tracks 不删卡,
   * 派生值会把轨道数顶回去 —— 所以删卡和减 tracks 在同一次 setOverlay 里做。
   */
  const handleDeleteTrack = async (track: number) => {
    if (trackCount <= 1) return;
    const victims = (overlay?.cards ?? []).filter((c) => trackOf(c) === track);
    if (victims.length) {
      const ok = await askConfirm(
        `删除${trackLabel(track)}?\n\n上面的 ${victims.length} 张卡会一起删掉。\n可以用 ⌘Z 撤销。`,
        "删除轨道",
      );
      if (!ok) return;
    }
    pushHistory(true);
    setOverlay((o) => {
      if (!o) return o;
      const cards = o.cards
        .filter((c) => trackOf(c) !== track)
        .map((c) => {
          const t = trackOf(c);
          if (t <= track) return c;
          const nt = t - 1;
          return { ...c, track: nt <= 1 ? undefined : nt };
        });
      return {
        ...o,
        cards,
        tracks: Math.max(1, tracksOf(o) - 1),
        trackNames: remapNames(o.trackNames, (t) => (t === track ? 0 : t > track ? t - 1 : t)),
      };
    });
    if (victims.some((v) => v.id === selCardId)) setSelCardId(null);
    setActiveTrack((a) => (a > track ? a - 1 : a === track ? Math.max(1, track - 1) : a));
  };

  const handleExport = async () => {
    if (exporting) return;
    if (!overlay || overlay.cards.length === 0) {
      alert("时间轴上还没有卡片:先 📥 导入 JSON,或打开 📚 素材库把卡加进来。");
      return;
    }
    setExporting(true);
    // 完成时发系统通知(切去别的应用也能收到);先申请权限
    if ("Notification" in window && Notification.permission === "default")
      Notification.requestPermission().catch(() => {});
    // 每秒轮询导出进度,驱动右下角进度浮窗
    const poll = window.setInterval(async () => {
      try {
        const r = await fetch("/api/export-status");
        const p = await r.json();
        if (p.running) setExportProg(p);
      } catch {
        /* 服务器重启等瞬时失败,忽略 */
      }
    }, 1000);
    // 学习闭环:定稿导出时也落一份「初选 vs 终选」日志
    if (overlay) {
      fetch("/api/review-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          savedAt: new Date().toISOString(),
          origin: originRef.current,
          final: overlay,
        }),
      }).catch(() => {});
      maybeShowLearnTip();
    }
    try {
      // 导出帧率:相机/手机拍的素材是 NTSC 29.97fps(30000/1001),动效层按 30 导会
      // 越走越快 —— 166s 累计漂移约 5 帧,片尾能看出动效和口型对不上
      const EXPORT_FPS = 29.97;
      // 导出整条 overlay(时长 = 最后一张卡结束 + 0.5s 尾巴)
      // 尾巴是留给末尾音效收干净的,别用 ceil 取整 —— 28.0s 的片子会被抬到 29s,
      // 白白多出整整一秒空帧(卡片走到 end 就卸掉了,尾巴里什么都没有)。
      if (!overlay) return; const body = { mode: "timeline", doc: overlay, scale: 1, speed: 1, fps: EXPORT_FPS, duration: Math.max(...overlay.cards.map((c) => c.end)) + 0.5 };
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 线上试玩版没有导出后端(逐帧渲染要本地无头 Chrome + ffmpeg):给友好提示,不甩报错。
      // 判断依据只能是「返回的不是 JSON」—— 静态托管会回 HTML(404 或 SPA 回退)。
      // 不能用 !res.ok:本地导出失败时服务端返回的是 500 + JSON,里面带着真正的
      // 失败原因,当成"线上版"会把这条信息直接丢掉,客户和你都不知道到底为什么失败。
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        alert(
          "🌐 当前是线上试玩版,不支持导出。\n\n导出透明 MOV 需要在本地运行:\n  git clone 仓库 → npm install → npm run dev\n\n完整步骤见 README「快速开始」。",
        );
        return;
      }
      const data = await res.json();
      if (data.ok) {
        if ("Notification" in window && Notification.permission === "granted")
          new Notification("✅ 动效层导出完成", {
            body: data.mov ? `MOV 已就绪:${String(data.mov).split("/").pop()}` : "PNG 序列已就绪",
          });
        if (!data.mov) {
          alert(
            "⚠️ 只导出了 PNG 序列,没有生成 MOV。\n\n" +
              "原因:本机没有装 ffmpeg(合成透明视频要用它)。\n\n" +
              "装好之后重新导出即可:\n" +
              "  macOS:   brew install ffmpeg\n" +
              "  Windows: winget install --id Gyan.FFmpeg -e\n\n" +
              `PNG 序列已经在这儿了:\n${data.dir}`,
          );
          return;
        }
        const files = [
          data.mov ? `🎞 透明 MOV(剪映直接拖):\n${data.mov}` : null,
          data.webm ? `🌐 透明 WebM(小体积):\n${data.webm}` : null,
          `🖼 PNG 序列 ${data.frames} 帧 @ ${data.fps}fps`,
        ]
          .filter(Boolean)
          .join("\n\n");
        alert(`✅ 导出完成!\n\n${files}\n\n文件夹:\n${data.dir}`);
      } else {
        const raw = String(data.error ?? "未知错误");
        const i = raw.lastIndexOf("【导出失败原因】");
        alert(`❌ 导出失败\n\n${i === -1 ? raw : raw.slice(i)}`);
      }
    } catch (e) {
      alert(`❌ 导出失败:${e}`);
    } finally {
      window.clearInterval(poll);
      setExporting(false);
      setExportProg(null);
    }
  };

  const handleVideo = async (file: File | null) => {
    if (videoBusy) return;
    camClearedRef.current = false; // 换了视频,之前那次「清除」不作数
    // 记住换之前的主视频:下面落盘成功后,如果全局「口播视频」(overlay.cam)就是它,要跟着换。
    // 以前不换 —— 自动挂载只在 cam 为空时生效,换视频后 cam 还指着上一条:预览里运镜卡
    // 圆窗放的是新视频(预览用 videoUrl),导出烤进去的却是旧的(导出用 doc.cam),而且没有任何提示。
    // 只在「cam 等于旧主视频」时换:用户在侧栏手动选过别的口播视频,那是他的选择,不动。
    const prevUrl = videoUrl;
    setVideoUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
    if (!file) {
      setVideoDur(0);
      setPlaying(false);
      return;
    }
    setPlaying(false);
    setVideoBusy(true);
    // 先落盘换一个真实路径:刷新后能自动恢复,无头 Chrome 导出时也读得到。
    // 线上试玩版没有这个后端,退回 blob 地址 —— 那种情况下刷新仍需重新导入。
    try {
      const r = await fetch("/api/media", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name) },
        body: file,
      });
      // 非 2xx 也要把响应体读出来:后台写盘失败时会认真回一句原因(500 + JSON),
      // 以前 `r.ok ? … : null` 直接把它扔了,页面一声不吭退回 blob,用户以为导入成功了
      const d = await r.json().catch(() => null);
      if (d?.ok && d.url) {
        setVideoUrl(d.url);
        setOverlay((o) => (o && o.cam && o.cam === prevUrl ? { ...o, cam: d.url } : o));
        return;
      }
      alert(
        `❌ 视频落盘失败:${d?.error ?? `HTTP ${r.status}`}\n\n` +
          "先用临时地址预览;这种情况下刷新要重新导入,导出时也带不上口播。",
      );
    } catch (e) {
      // 本地服务没在跑的时候会走到这儿。以前这里一声不吭地退回 blob,用户不知道后台已经
      // 掉线,只会觉得「刷新一次素材就没了」。和其他三个上传入口一样弹一句人话;
      // 顶部横幅交给心跳去判(它要连续两次探不到才报,这里一次失败就翻旗会闪一下又消失)。
      alert(`❌ 视频落盘失败:${uploadErrText(e)}`);
    } finally {
      setVideoBusy(false);
    }
    setVideoUrl(URL.createObjectURL(file));
  };

  // ---- 素材库 ↔ 编辑台 ----
  /** 素材库「设为口播视频」(存 doc.cam):空串 = 用户主动清过,自动挂载别再填回来 */
  const handleSetCam = (src: string) => {
    camClearedRef.current = !src;
    setOverlay((o) =>
      o ? { ...o, cam: src || undefined } : src ? { version: 1 as const, cards: [], cam: src } : o,
    );
  };

  /** 素材库「设为画布参考视频」:src 已经在 /_media 里,直接换,不再上传;
      和顶栏「换视频」一样,全局口播视频原本就是旧主视频的话跟着换 */
  const applyVideoSrc = (src: string) => {
    if (!src || src === videoUrl) return;
    camClearedRef.current = false;
    const prevUrl = videoUrl;
    setVideoUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return src;
    });
    setOverlay((o) => (o && o.cam && o.cam === prevUrl ? { ...o, cam: src } : o));
    setPlaying(false);
  };

  /** 切顶级分页:离开素材库时把悬停预览一起收掉 —— 列表整片卸载,mouseleave 不一定还会来,
      不清的话那个浮窗会挂在编辑台上不走 */
  const handleSideTab = (t: "edit" | "library") => {
    setSideTab(t);
    if (t !== "library") setHover({ item: null, anchor: null });
  };

  // 时间轴上所有卡的区间:素材库的字幕句用它标「这句已经有卡覆盖了」
  const cardSpans = useMemo(
    () => (overlay?.cards ?? []).map((c) => [c.start, c.end] as [number, number]),
    [overlay],
  );

  // 参数面板:改选中的卡。查不到(编排里有本档没有的卡)就照实传 undefined,由 ParamsPanel 说清楚是哪张
  const panelEffect = selCard ? EFFECTS.find((e) => e.id === selCard.kind) : undefined;

  // ---- AI 助手 ↔ 编辑台(契约 AI-ASSISTANT-DESIGN.md §5.3 的 EditorApi) ----
  // AI 通过 MCP 调的工具最终落到这里。对象每次渲染重建、存进 ref:执行器用 getApi() 拿到的
  // 永远是最新一次渲染的闭包(overlay / curT 都是新的),订阅本身只挂一次。
  // 建卡 / 改卡都先做占用检查,冲突就 throw —— 错误原文会原样回给 AI,让它换时段或换序列。
  const trackNamesNow = overlay?.trackNames;
  const clashOn = (track: number, start: number, end: number, exceptId?: string) =>
    (overlay?.cards ?? []).find(
      (c) => c.id !== exceptId && trackOf(c) === track && c.start < end && c.end > start,
    );
  const clashText = (track: number, c: OverlayCard) =>
    `${trackLabel(track, trackNamesNow)} 在 ${c.start}–${c.end} 秒已被 ${c.id}(${effectName(c.kind)})占用,换个时段或换条序列`;
  const aiApi: EditorApi = {
    getState: () => ({
      curT,
      duration,
      playing,
      videoUrl: videoUrl ?? undefined,
      srtName,
      trackCount,
      trackNames: trackNamesNow,
      cards: (overlay?.cards ?? []).map((c) => ({
        id: c.id,
        kind: c.kind,
        name: effectName(c.kind),
        start: c.start,
        end: c.end,
        track: trackOf(c),
        summary: cardSummary(c),
      })),
      videoAssets: listVideoAssets().map((v) => ({ id: v.id, name: v.name, src: v.src, durationSec: v.durationSec })),
      srtAssets: listSrtAssets().map((a) => ({
        id: a.id,
        name: a.name,
        lines: a.lines.length,
        duration: srtDuration(a.lines),
      })),
    }),
    getCard: (id) => overlay?.cards.find((c) => c.id === id),
    addCard: ({ kind, start, end, track, params }) => {
      const def = EFFECTS.find((e) => e.id === kind);
      if (!def) throw new Error(`没有这种卡:${kind}(先用 list_effects 看有哪些 kind)`);
      const t = Math.max(1, Math.floor(track ?? activeTrack));
      const s = Math.max(0, start);
      // end 不传:默认时长,但顶到同序列下一张卡为止
      let gapEnd = Infinity;
      for (const c of overlay?.cards ?? []) {
        if (trackOf(c) === t && c.start > s) gapEnd = Math.min(gapEnd, c.start);
      }
      const e = end ?? Math.min(s + addSecFor(kind), gapEnd);
      if (e <= s) throw new Error(`end(${e})必须大于 start(${s})`);
      const clash = clashOn(t, s, e);
      if (clash) throw new Error(clashText(t, clash));
      const cards = overlay?.cards ?? [];
      let n = cards.length + 1;
      while (cards.some((c) => c.id === `card-${n}`)) n++;
      const card: OverlayCard = {
        id: `card-${n}`,
        kind,
        start: s,
        end: e,
        track: t > 1 ? t : undefined,
        params: { ...def.defaults, ...(params ?? {}) },
      };
      pushHistory(true);
      setOverlay((o) => {
        if (!o) return { version: 1 as const, cards: [card], tracks: t > 1 ? t : undefined };
        const cur = Math.max(o.tracks ?? 1, o.cards.length ? Math.max(...o.cards.map(trackOf)) : 1);
        return {
          ...o,
          cards: [...o.cards, card].sort((a, b) => a.start - b.start),
          tracks: t > 1 ? Math.max(cur, t) : o.tracks,
        };
      });
      setSelCardId(card.id);
      setActiveTrack(t);
      return { id: card.id, start: s, end: e, track: t };
    },
    updateCard: ({ id, start, end, track, params }) => {
      const c = overlay?.cards.find((x) => x.id === id);
      if (!c) throw new Error(`没有这张卡:${id}(用 get_editor_state 看现有的 id)`);
      const ns = start ?? c.start;
      const ne = end ?? c.end;
      if (ne <= ns) throw new Error(`end(${ne})必须大于 start(${ns})`);
      const nt = track !== undefined ? Math.max(1, Math.floor(track)) : trackOf(c);
      const clash = clashOn(nt, ns, ne, id);
      if (clash) throw new Error(clashText(nt, clash));
      pushHistory(true);
      setOverlay((o) =>
        o
          ? {
              ...o,
              cards: o.cards
                .map((x) =>
                  x.id === id
                    ? {
                        ...x,
                        start: ns,
                        end: ne,
                        track: nt > 1 ? nt : undefined,
                        params: params ? { ...x.params, ...params } : x.params,
                      }
                    : x,
                )
                .sort((a, b) => a.start - b.start),
              tracks: nt > 1 ? Math.max(o.tracks ?? 1, nt) : o.tracks,
            }
          : o,
      );
    },
    removeCard: (id) => {
      if (!overlay?.cards.some((c) => c.id === id)) throw new Error(`没有这张卡:${id}`);
      handleDeleteCard(id);
    },
    importSrt: (name, lines, use) => {
      if (!lines.length) throw new Error("字幕里一句都没有(检查 srt_text 的时间行格式 00:00:01,000 --> 00:00:03,000)");
      const asset = addSrtAsset({ name, lines });
      if (use) applySrtLines(lines, name);
      return { id: asset.id };
    },
    registerVideo: ({ url, name, setAs, durationSec }) => {
      const fallbackName = decodeURIComponent(url.split("/").pop()?.split("?")[0] || url);
      const asset = addVideoAsset({ name: name || fallbackName, src: url, durationSec });
      if (setAs === "reference") applyVideoSrc(asset.src);
      else if (setAs === "cam") handleSetCam(asset.src);
      return { id: asset.id, url: asset.src };
    },
    seek: (t) => seek(Math.max(0, t)),
    setPlaying: (b) => {
      if (b && durRef.current <= 0) throw new Error("还没有可播放的内容(没有视频也没有卡)");
      setPlaying(b);
    },
  };
  const aiApiRef = useRef(aiApi);
  aiApiRef.current = aiApi;
  useEffect(
    () => connectMcpExecutor(() => aiApiRef.current, ({ connected }) => setMcpConnected(connected)),
    [],
  );

  return (
    <div
      className="app"
      /* 拖文件进窗口即导入:视频 → 垫底预览,JSON → 时间轴 */
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (!f) {
          alert("❌ 没有读到文件——请从「访达」把文件本体拖进来(从应用里直接拖可能拖不出文件)。");
          return;
        }
        if (f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(f.name)) {
          handleVideo(f);
        } else if (f.type === "application/json" || /\.json$/i.test(f.name)) {
          handleImportJson(f);
        } else if (/\.srt$/i.test(f.name)) {
          handleImportSrt(f);
        } else {
          alert(`❌ 不认识的文件类型:${f.name}(支持视频 mp4/mov/webm、overlay JSON 和 SRT 字幕)`);
        }
      }}
    >
      {!online && (
        <div className="offline-bar">
          ⚠️ 本地服务已停止 —— 这个页面还开着,但导入、上传、导出都不会成功。
          回到启动时那个终端窗口,重新运行 <code>npm run dev</code>(或再双击一次启动器),然后刷新本页。
        </div>
      )}
      <TopBar
        shown={activeCards.length}
        total={overlay?.cards.length ?? 0}
        stats={overlayStats}
        selCardId={selCardId}
        onImportJson={handleImportJson}
        onLoadDemo={handleLoadDemo}
        exporting={exporting}
        hasVideo={videoUrl !== null}
        videoBusy={videoBusy}
        onVideo={handleVideo}
        onExport={handleExport}
        form={form}
        onForm={pickForm}
        palette={palette}
        onPalette={setPalette}
        hasDoc={!!overlay}
        font={overlay?.font ?? ""}
        onFont={(f) => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, font: f || undefined } : o));
        }}
        glow={!!overlay?.glow}
        onToggleGlow={() => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, glow: !o.glow } : o));
        }}
        inkColor={overlay?.inkColor ?? ""}
        onInkColor={(c) => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, inkColor: c || undefined } : o));
        }}
        onUnifyAccent={(accent) => {
          // 批量改写:把每张卡的 accent 参数直接改掉(不是盖一层),
          // 改完各卡参数面板显示的就是新值,之后还能单张调回去。force 压一步撤销。
          pushHistory(true);
          setOverlay((o) =>
            o
              ? {
                  ...o,
                  cards: o.cards.map((c) =>
                    "accent" in (c.params ?? {})
                      ? { ...c, params: { ...c.params, accent } }
                      : c,
                  ),
                }
              : o,
          );
        }}
        theme={overlay?.theme}
        onGlobalTheme={handleGlobalTheme}
        skin={overlay?.skin ?? ""}
        onSkin={(s) => setOverlay((o) => (o ? { ...o, skin: s || undefined } : o))}
        docStyle={overlay?.style ?? ""}
        onDocStyle={(s) => setOverlay((o) => (o ? { ...o, style: s || undefined } : o))}
        sideColor={overlay?.sideColor ?? ""}
        onSideColor={(c) => setOverlay((o) => (o ? { ...o, sideColor: c || undefined } : o))}
        videoScale={videoScale}
        onVideoScale={setVideoScale}
        onExportJson={handleExportJson}
      />
      <div className="app-body">
      <Sidebar
        overlay={overlay}
        selCardId={selCardId}
        onSelectCard={(id) => {
          selectCard(id);
          const c = overlay?.cards.find((x) => x.id === id);
          if (c) seek(c.start + 0.01);
        }}
        onImportJson={handleImportJson}
        onClearOverlay={handleClearOverlay}
        trackCount={trackCount}
        trackNames={overlay?.trackNames}
        activeTrack={activeTrack}
        onSelectTrack={setActiveTrack}
        tab={sideTab}
        onTab={handleSideTab}
        library={{
          activeTrack,
          trackNames: overlay?.trackNames,
          srtName,
          curT,
          cardSpans,
          videoSrc: videoUrl,
          camSrc: overlay?.cam,
          onAddCard: handleLibraryAddCard,
          onSetVideo: applyVideoSrc,
          onSetCam: handleSetCam,
          onUseSrt: (name, lines) => applySrtLines(lines, name),
          onSeek: seek,
          onHover: (item, anchor) => setHover({ item, anchor }),
          // 预设「＋ 加到 序列n」:和普通卡一样插到播放头处,只是 params 用预设里存的那份
          onAddPreset: (kind, params) =>
            insertCard(kind, Math.round(curTRef.current * 10) / 10, activeTrack, { params }),
        }}
        bottom={
          /* 单卡参数面板住在左栏下半部分(右栏整栏给了 AI 助手) */
          <ParamsPanel
            embedded
            effect={panelEffect}
            params={selCard?.params}
            onChange={handleCardParamChange}
            onChangeMany={patchCardParams}
            card={selCard}
            editMode
            onLayer={handleCardLayer}
            layer={layerInfo}
            onTimeChange={handleCardTimeChange}
            onKindChange={handleCardKindChange}
            onDelete={handleDeleteCard}
            trackCount={trackCount}
            trackNames={overlay?.trackNames}
            cardTrack={selCard ? trackOf(selCard) : undefined}
            onTrack={(track) => selCardId && handleCardTrack(selCardId, track)}
            batch={batch || undefined}
            onApplyAll={handleApplyAll}
          />
        }
      />

      <main className="stage-col">
        <Canvas
          /* 画布永远是时间轴模式(overlayCards 非空);单卡预览是素材库的悬停浮窗(HoverPreview)。
             effect / params / playToken 是 Canvas 单卡模式的必填项,这里只是占位,不会画出来 */
          effect={EFFECTS[0]}
          params={EFFECTS[0].defaults}
          playToken={0}
          showGuides={showGuides}
          showPerson={showPerson}
          videoUrl={videoUrl}
          fxScale={1}
          overlayCards={activeCards}
          now={curT}
          overlayTheme={overlay?.theme}
          glow={overlay?.glow ?? false}
          font={overlay?.font}
          skin={overlay?.skin}
          docStyle={overlay?.style}
          sideColor={overlay?.sideColor}
          inkColor={overlay?.inkColor}
          videoMuted={muted}
          videoScale={videoScale}
          animSpeed={1}
          videoElRef={(el) => (videoRef.current = el)}
          onVideoMeta={setVideoDur}
          onNudge={handleNudge}
          onPickCard={setSelCardId}
        />
        {/* 预览画面下面的操作栏:归零 / 播放 / 声音 + 当前时间(从顶栏挪过来的) */}
        <StageControls
          curT={curT}
          duration={duration}
          playing={playing}
          muted={muted}
          onPlayPause={() => durRef.current > 0 && setPlaying((p) => !p)}
          onReset={() => {
            setPlaying(false);
            seek(0);
          }}
          onToggleMute={() => setMuted((m) => !m)}
          showGuides={showGuides}
          onToggleGuides={() => setShowGuides((v) => !v)}
          showPerson={showPerson}
          onTogglePerson={() => setShowPerson((v) => !v)}
        />
        <TimelineBar
          duration={duration}
          t={curT}
          cards={overlay?.cards ?? []}
          videoTracks={videoTracks}
          selectedId={selCardId}
          onSeek={seek}
          onSelect={selectCard}
          onTimes={handleCardTimes}
          trackCount={trackCount}
          onAddTrack={handleAddTrack}
          onDropEffect={handleDropEffect}
          onTrack={handleCardTrack}
          onDeleteTrack={handleDeleteTrack}
          onInsertTrack={handleInsertTrack}
          onReorderTrack={handleReorderTrack}
          trackNames={overlay?.trackNames}
          onRenameTrack={handleRenameTrack}
        />
      </main>

      {/* 右栏:AI 助手(Claude Code / agy / Codex / API 直连)。它通过后台的 MCP 桥读写编辑台,
          绿点 = 这个页面已连上桥。单卡参数面板搬去了左栏下半部分 */}
      <AiPanel mcpConnected={mcpConnected} />
      </div>

      {/* 素材库的悬停预览:portal 到 body,不受左栏 overflow 影响。
          它自己另起一份动画,绝不碰 window.__fxExportMs —— 碰了画布上正在播的卡会被冻住 */}
      <HoverPreview
        item={hover.item}
        anchor={hover.anchor}
        theme={overlay?.theme}
        skin={overlay?.skin}
        docStyle={overlay?.style}
        font={overlay?.font}
        glow={overlay?.glow ?? false}
        sideColor={overlay?.sideColor}
        inkColor={overlay?.inkColor}
      />

      {/* 导出进度浮窗(右下角):渲染帧数 + 预计剩余 + 合成阶段 */}
      {exporting && <ExportProgress prog={exportProg} />}

      {/* 检查器浮窗(左下角):导入 JSON 自动体检的结果,只提醒不阻断 */}
      {lintIssues.length > 0 && (
        <LintPanel
          issues={lintIssues}
          collapsed={lintCollapsed}
          onToggle={() => setLintCollapsed((v) => !v)}
          onClose={() => setLintIssues([])}
          onLocate={handleLintLocate}
          onIgnore={handleLintIgnore}
        />
      )}

      <ConfirmDialog
        open={!!confirmReq}
        title={confirmReq?.title}
        message={confirmReq?.message ?? ""}
        onConfirm={() => handleConfirmClose(true)}
        onCancel={() => handleConfirmClose(false)}
      />
    </div>
  );
}

function LintPanel({
  issues,
  collapsed,
  onToggle,
  onClose,
  onLocate,
  onIgnore,
}: {
  issues: LintIssue[];
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  onLocate: (i: LintIssue) => void;
  onIgnore: (i: LintIssue) => void;
}) {
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <div className="lint-panel">
      <div className="lint-head" onClick={onToggle}>
        <span>
          🔍 体检:{errors > 0 && <b className="lint-err-count">{errors} 个必修</b>}
          {errors > 0 && issues.length > errors && " · "}
          {issues.length > errors && `${issues.length - errors} 个建议`}
        </span>
        <span className="lint-head-btns">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {collapsed ? "展开" : "收起"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ✕
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="lint-list">
          {issues.map((i, idx) => (
            <div key={idx} className={`lint-item lint-${i.level}`}>
              <span className="lint-msg">
                {i.level === "error" ? "❌" : "⚠️"} {i.message}
              </span>
              <span className="lint-btns">
                {(i.cardId || i.at != null) && <button onClick={() => onLocate(i)}>定位</button>}
                <button title={i.cardId ? "写进这张卡,以后不再提醒" : "本次不再显示"} onClick={() => onIgnore(i)}>
                  忽略
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExportProgress({
  prog,
}: {
  prog: { stage: string; frame: number; total: number; startedAt: number; framesAt: number } | null;
}) {
  let pct = 2;
  let text = "准备中(启动渲染器)…";
  if (prog) {
    if (prog.stage === "extract") {
      text = "预处理素材:把卡片里的视频抽成帧(长录屏要几分钟)…";
    } else if (prog.stage === "frames" && prog.total > 0) {
      // 渲染帧占进度的前 80%,后面是合成/混音
      pct = Math.max(2, Math.round((prog.frame / prog.total) * 80));
      // ⚠️ 只按「逐帧渲染开跑之后」的耗时算(framesAt,不是 startedAt)。
      // 用任务启动时刻的话,前面抽帧/启浏览器那几分钟会被摊进每帧耗时,
      // 第一次报数(第 30 帧)能报出几十分钟,然后一路往下掉 —— 纯属吓人。
      const elapsed = (Date.now() - (prog.framesAt || prog.startedAt)) / 1000;
      const eta =
        prog.frame > 0
          ? Math.round((elapsed / prog.frame) * (prog.total - prog.frame))
          : 0;
      const fmt =
        eta >= 60 ? `${Math.floor(eta / 60)} 分 ${eta % 60} 秒` : `${eta} 秒`;
      text = `渲染帧 ${prog.frame}/${prog.total} · 预计还需 ${fmt}`;
    } else if (prog.stage === "mov") {
      pct = 84;
      text = "合成透明 MOV(长视频这步要几分钟)…";
    } else if (prog.stage === "webm") {
      pct = 93;
      text = "合成 WebM 小体积版…";
    } else if (prog.stage === "sfx") {
      pct = 98;
      text = "把音效混进 MOV…";
    }
  }
  return (
    <div className="export-prog">
      <div className="export-prog-head">
        <span>🎞 导出中</span>
        <b>{pct}%</b>
      </div>
      <div className="export-prog-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="export-prog-sub">{text}</div>
    </div>
  );
}
