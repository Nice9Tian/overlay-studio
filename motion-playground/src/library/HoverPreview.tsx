import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Canvas } from "../components/Canvas";
import { EFFECTS } from "../effects/registry";
import { kindColor } from "../effects/kindColor";
import { listSrtAssets, listVideoAssets, srtDuration } from "./assets";
import type { LibrarySelection } from "./LibraryTab";
import "./HoverPreview.css";

/**
 * 素材库的悬停预览浮窗。
 *
 * portal 到 body,所以不受左栏 overflow 裁剪;`pointer-events: none`,纯展示,
 * 永远不抢鼠标(鼠标还在列表项上,列表的 mouseleave / scroll 照常触发)。
 *
 * 动效卡预览就是一个正常挂载的 Canvas —— 进场动画自己播一遍就停。
 * 这里**不碰** `window.__fxExportMs`(那是导出用的全局虚拟时钟,一旦接管
 * 会把编辑台画布上正在播的卡一起冻住),归档版预览器的做法在这里是禁止的。
 */

export interface HoverPreviewProps {
  item: LibrarySelection; // null = 不显示
  anchor: DOMRect | null; // 被悬停的列表项的屏幕矩形
  /** 编辑台全局外观,让预览和画布一致(都可缺省) */
  theme?: "dark" | "light";
  skin?: string;
  docStyle?: string;
  font?: string;
  glow?: boolean;
  sideColor?: string;
  inkColor?: string;
}

/** 浮窗宽度,和 HoverPreview.css 里的 .hp-pop 必须一致 */
const POP_W = 400;
/** 浮窗和列表项之间的横向间距 */
const GAP = 10;
/** 离视口边缘至少留出的空隙 */
const EDGE = 8;
/** 悬停多久才浮出来(手快掠过整列时不闪) */
const DELAY_MS = 220;
/** 字幕最多预览几句 */
const MAX_LINES = 6;

/** m:ss */
function fmtMS(sec: number): string {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** m:ss.s(和素材列表里的时长口径一致) */
function fmtMSS(sec: number): string {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

export function HoverPreview({
  item,
  anchor,
  theme,
  skin,
  docStyle,
  font,
  glow,
  sideColor,
  inkColor,
}: HoverPreviewProps) {
  const popRef = useRef<HTMLDivElement>(null);

  // 当前悬停的是哪个素材;换素材 = 换 key,定时器和内容都重来
  const key = item ? `${item.type}:${item.id}` : "";
  // 已经熬过 220ms、可以显示的那个 key(""= 不显示)
  const [readyKey, setReadyKey] = useState("");
  // 每次真正显示都 +1,让动效卡的进场动画重放
  const [token, setToken] = useState(1);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 延时显示:item 变非 null 起算 220ms;期间又变了就重新计时;变 null 立即收
  useLayoutEffect(() => {
    if (!key) {
      setReadyKey("");
      return;
    }
    setReadyKey("");
    setPos(null);
    const t = window.setTimeout(() => {
      setReadyKey(key);
      setToken((n) => n + 1);
    }, DELAY_MS);
    return () => window.clearTimeout(t);
  }, [key]);

  const open = !!key && readyKey === key;

  const data = useMemo(() => {
    if (!open || !item) return null;
    if (item.type === "effect") {
      const def = EFFECTS.find((e) => e.id === item.id);
      return def ? ({ kind: "effect", def } as const) : null;
    }
    if (item.type === "video") {
      const video = listVideoAssets().find((v) => v.id === item.id);
      return video ? ({ kind: "video", video } as const) : null;
    }
    const srt = listSrtAssets().find((s) => s.id === item.id);
    return srt ? ({ kind: "srt", srt } as const) : null;
  }, [open, item]);

  // 摆位:默认贴在列表项右边,放不下就翻到左边,再夹进视口
  // (高度要量完才知道,所以 ResizeObserver 盯着内容变化再夹一次)
  useLayoutEffect(() => {
    if (!open || !anchor || !data) {
      setPos(null);
      return;
    }
    const el = popRef.current;
    if (!el) return;
    const place = () => {
      const h = el.getBoundingClientRect().height;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = anchor.right + GAP;
      if (left + POP_W > vw - EDGE) left = anchor.left - GAP - POP_W;
      left = Math.max(EDGE, Math.min(left, vw - EDGE - POP_W));
      let top = Math.min(anchor.top, vh - EDGE - h);
      top = Math.max(EDGE, top);
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, anchor, data]);

  // item 变 null(或素材已经不在登记表里)→ 整个卸载,Canvas 一起走,别留后台动画
  if (!open || !anchor || !data) return null;

  let body: ReactNode = null;

  if (data.kind === "effect") {
    const def = data.def;
    body = (
      <>
        <div className="hp-head">
          <div className="hp-title">
            <i className="hp-dot" style={{ background: kindColor(def.id) }} />
            {def.name}
          </div>
          <div className="hp-desc">{def.description}</div>
          {def.tags?.length ? (
            <div className="hp-tags">
              {def.tags.map((t) => (
                <span className="hp-tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="hp-stage">
          <Canvas
            effect={def}
            params={{ ...def.defaults, theme: def.defaults.theme ?? theme ?? "dark" }}
            playToken={token}
            showGuides={false}
            showPerson
            videoUrl={null}
            fxScale={1}
            overlayCards={null}
            overlayTheme={theme}
            glow={glow}
            font={font}
            skin={skin}
            docStyle={docStyle}
            sideColor={sideColor}
            inkColor={inkColor}
            animSpeed={1}
          />
        </div>
      </>
    );
  } else if (data.kind === "video") {
    const video = data.video;
    body = (
      <>
        <div className="hp-stage">
          <video
            className="hp-video"
            muted
            autoPlay
            loop
            playsInline
            preload="metadata"
            src={video.src}
          />
        </div>
        <div className="hp-head">
          <div className="hp-title">{video.name}</div>
          <div className="hp-sub">
            {video.durationSec ? fmtMSS(video.durationSec) : "时长未知"}
          </div>
        </div>
      </>
    );
  } else {
    const srt = data.srt;
    const shown = srt.lines.slice(0, MAX_LINES);
    const rest = srt.lines.length - shown.length;
    body = (
      <>
        <div className="hp-head">
          <div className="hp-title">{srt.name}</div>
          <div className="hp-sub">
            {srt.lines.length} 句 · {fmtMS(srtDuration(srt.lines))}
          </div>
        </div>
        <div className="hp-lines">
          {shown.map((l, i) => (
            <div className="hp-line" key={i}>
              <span className="hp-line-t">{fmtMS(l.start)}</span>
              <span className="hp-line-x">{l.text}</span>
            </div>
          ))}
          {rest > 0 ? <div className="hp-more">…还有 {rest} 句</div> : null}
        </div>
      </>
    );
  }

  return createPortal(
    <div
      ref={popRef}
      className="hp-pop"
      // 量完高度前先摆到视口外,useLayoutEffect 在这一帧画出来之前就会夹好
      style={{ left: pos ? pos.left : -9999, top: pos ? pos.top : 0 }}
    >
      {body}
    </div>,
    document.body,
  );
}
