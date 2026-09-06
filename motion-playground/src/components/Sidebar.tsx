import { useEffect, useRef, useState, useCallback } from "react";
import { kindColor } from "../effects/kindColor";
import type { OverlayDoc } from "../overlay/types";
import { trackOf } from "../overlay/types";
import { effectName, cardSummary, trackLabel } from "../overlay/cardLabel";
import { LibraryTab, type LibraryTabProps } from "../library/LibraryTab";
import "./SidebarTracks.css";

/** 左栏的顶级分页:编辑台(轨道 + 卡片列表)/ 素材库(动效卡 + 视频 + 字幕) */
export type SideTab = "edit" | "library";

interface SidebarProps {
  overlay: OverlayDoc | null;
  selCardId: string | null;
  onSelectCard: (id: string) => void;
  onImportJson: (file: File | null) => void;
  onClearOverlay: () => void;
  trackCount: number;
  activeTrack: number;
  onSelectTrack: (track: number) => void;
  /** 轨道自定义名(双击序列标签改的),没有的显示默认「序列n」 */
  trackNames?: Record<number, string>;
  /** 顶级分页:哪一页在前面 */
  tab: SideTab;
  onTab: (t: SideTab) => void;
  /** 素材库分页要的全部东西,整个对象透传给 LibraryTab(hotkeys 由这里定:显示时才接管 ↑↓) */
  library: Omit<LibraryTabProps, "hotkeys">;
}

function fmtT(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/**
 * 左栏:顶部两个顶级分页 —— 编辑台(按轨道分页的卡片列表)和素材库(src/library/LibraryTab)。
 * 素材库里挑动效卡(可直接拖进时间轴)、管视频素材和字幕稿;悬停预览由 App 渲染在 body 上。
 */
export function Sidebar({
  overlay,
  selCardId,
  onSelectCard,
  onImportJson,
  onClearOverlay,
  trackCount,
  activeTrack,
  onSelectTrack,
  trackNames,
  tab,
  onTab,
  library,
}: SidebarProps) {
  const jsonRef = useRef<HTMLInputElement>(null);
  const fxListRef = useRef<HTMLDivElement>(null);
  const isEdit = tab === "edit";

  // ↑ ↓ = 上一张 / 下一张卡(当前轨道上的;和点一下一样,播放头跟着跳过去)。
  // 只在编辑台分页挂:素材库分页显示时 ↑↓ 归它,用来走素材列表
  useEffect(() => {
    if (!isEdit) return;
    const ids = (overlay?.cards ?? []).filter((c) => trackOf(c) === activeTrack).map((c) => c.id);
    if (ids.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const el = e.target as HTMLElement;
      // 输入框(参数面板那些数字框)让位 —— 那儿的 ↑↓ 是加减数值
      if (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      e.preventDefault(); // 否则浏览器会顺手滚一下列表
      const cur = ids.indexOf(selCardId ?? "");
      const next =
        cur < 0 ? 0 : Math.min(Math.max(cur + (e.key === "ArrowDown" ? 1 : -1), 0), ids.length - 1);
      if (ids[next] !== selCardId) onSelectCard(ids[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isEdit, overlay, selCardId, onSelectCard, activeTrack]);
  // 选中的卡跟着滚进可视区(键盘连按时不会走丢;鼠标点的那张本来就在屏幕上,不会乱跳)
  useEffect(() => {
    fxListRef.current?.querySelector(".fx-item.is-on")?.scrollIntoView({ block: "nearest" });
  }, [selCardId, tab]);

  // 轨道页签横向滚动逻辑
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollWidth, clientWidth, scrollLeft } = el;
    const overflow = scrollWidth > clientWidth;
    setIsOverflowing(overflow);
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(Math.ceil(scrollLeft + clientWidth) < scrollWidth);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    checkScroll();
    const observer = new ResizeObserver(checkScroll);
    observer.observe(el);
    el.addEventListener("scroll", checkScroll);

    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", checkScroll);
    };
    // tab:切回编辑台时页签行是新挂上去的一批 DOM,要重新量一次、重新盯住
  }, [trackCount, overlay, checkScroll, tab]);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const activeTab = el?.querySelector(".side-tab.is-on");
    activeTab?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTrack, tab]);

  const handleScroll = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const target = Math.max(0, Math.min(max, el.scrollLeft + dir * el.clientWidth * 0.6));
    const before = el.scrollLeft;

    el.scrollTo({ left: target, behavior: "smooth" });
    checkScroll();

    if (scrollTimerRef.current !== null) {
      window.clearTimeout(scrollTimerRef.current);
    }
    scrollTimerRef.current = window.setTimeout(() => {
      if (el.scrollLeft === before && before !== target) {
        el.scrollLeft = target;
      }
      checkScroll();
    }, 80);
  };

  const trackCards = (overlay?.cards ?? []).filter((c) => trackOf(c) === activeTrack);

  return (
    <aside className="panel panel-left">
      {/* 顶级分页:编辑台 / 素材库。素材库以前是顶栏按钮开的浮层,现在就住在这儿 */}
      <div className="side-top">
        <button
          className={`side-top-tab ${isEdit ? "is-on" : ""}`}
          onClick={() => onTab("edit")}
          title="编辑台:当前编排的轨道和卡片"
        >
          编辑台
        </button>
        <button
          className={`side-top-tab ${isEdit ? "" : "is-on"}`}
          onClick={() => onTab("library")}
          title="素材库:动效卡 / 视频素材 / 字幕素材"
        >
          📚 素材库
        </button>
      </div>

      {!isEdit && <LibraryTab {...library} hotkeys />}

      {isEdit && (
        <>
          <div className="side-tabs">
            {isOverflowing && (
              <button
                className="side-tracks-arrow"
                disabled={!canScrollLeft}
                onClick={() => handleScroll(-1)}
              >
                ‹
              </button>
            )}
            <div className="side-tracks-scroll" ref={scrollRef}>
              {Array.from({ length: Math.max(1, trackCount) }).map((_, i) => {
                const tk = i + 1;
                const count = (overlay?.cards ?? []).filter((c) => trackOf(c) === tk).length;
                return (
                  <button
                    key={tk}
                    className={`side-tab ${activeTrack === tk ? "is-on" : ""}`}
                    onClick={() => onSelectTrack(tk)}
                  >
                    {/* 页签一多(溢出出现箭头)就缩成 序列17 (0):左栏只有 320px,可视区放不下「轨道 17 (0)」,
                        缩写和时间轴左侧的序列标签一致,用户对得上号。
                        起了自定义名的轨道,不溢出时也要显示那个名字,否则双击改的名在左栏看不到 */}
                    {isOverflowing || trackNames?.[tk]
                      ? `${trackLabel(tk, trackNames)} (${count})`
                      : `轨道 ${tk} (${count})`}
                  </button>
                );
              })}
            </div>
            {isOverflowing && (
              <button
                className="side-tracks-arrow"
                disabled={!canScrollRight}
                onClick={() => handleScroll(1)}
              >
                ›
              </button>
            )}
            {isOverflowing && (
              <span className="side-tracks-count">
                {activeTrack}/{trackCount}
              </span>
            )}
            {overlay && (
              <button className="tl-clear" onClick={onClearOverlay}>
                清空
              </button>
            )}
          </div>
          <input
            ref={jsonRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              onImportJson(e.target.files?.[0] ?? null);
              if (jsonRef.current) jsonRef.current.value = "";
            }}
          />
          <div className="fx-list" ref={fxListRef}>
            {trackCards.length > 0 ? (
              trackCards.map((c, i) => (
                <button
                  key={c.id}
                  className={`fx-item fx-item--row fx-item-track ${c.id === selCardId ? "is-on" : ""}`}
                  onClick={() => onSelectCard(c.id)}
                >
                  <span className="fx-idx">{String(i + 1).padStart(2, "0")}</span>
                  <span className="fx-meta side-tracks-meta">
                    <span className="fx-name side-tracks-name">
                      <i className="fx-dot" style={{ background: kindColor(c.kind) }} />
                      <b>{effectName(c.kind)}</b>
                      <span className="side-tracks-summary">{cardSummary(c)}</span>
                    </span>
                  </span>
                  <span className="fx-time">
                    {fmtT(c.start)}–{fmtT(c.end)}
                  </span>
                </button>
              ))
            ) : (
              <div className="fx-empty">
                轨道 {activeTrack}({trackLabel(activeTrack, trackNames)}) 上还没有卡片。
                <br />
                <span
                  className="fx-empty-link"
                  role="button"
                  tabIndex={0}
                  onClick={() => jsonRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      jsonRef.current?.click();
                    }
                  }}
                >
                  📥 导入 JSON
                </span>
                ,
                <br />
                或去上面的{" "}
                <span
                  className="fx-empty-link"
                  role="button"
                  tabIndex={0}
                  onClick={() => onTab("library")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onTab("library");
                    }
                  }}
                >
                  📚 素材库
                </span>{" "}
                挑一张,加到 {trackLabel(activeTrack, trackNames)}。
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
