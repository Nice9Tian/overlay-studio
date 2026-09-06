/**
 * 素材库分页(契约:LIBRARY-TAB-DESIGN.md)。
 *
 * 左栏顶级分页「素材库」里的那一页:动效卡(搜索 / 标签 / 分组)+ 视频素材 + 字幕素材。
 * 它只是左栏里的一页 —— 没有预览浮窗(App 渲染 HoverPreview,portal 到 body),
 * 没有参数抽屉(参数在右栏调),也没有跨窗口的 bus(和编辑台同住一个页面,直接走 props)。
 *
 * 两条用法:
 * - 拖:动效卡 draggable,写 application/x-overlay-effect,TimelineBar 接住 → 落在拖到的那条轨道那个位置;
 * - 点:选中后底部动作栏「＋ 加到 序列n」/「设为画布参考视频」/「用作本期字幕稿」。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EffectDef, VisualTag } from "../effects/types";
import { VISUAL_TAGS } from "../effects/types";
import { EFFECT_GROUPS, EFFECTS } from "../effects/registry";
import { kindColor } from "../effects/kindColor";
import { trackLabel } from "../overlay/cardLabel";
import type { SrtLine } from "../overlay/srt";
import {
  listVideoAssets,
  removeVideoAsset,
  importVideoFile,
  listSrtAssets,
  removeSrtAsset,
  importSrtFile,
  srtDuration,
  subscribeAssets,
  type VideoAsset,
  type SrtAsset,
} from "./assets";
import "./LibraryTab.css";

export type LibrarySelection =
  | { type: "effect"; id: string } // id = 特效 kind
  | { type: "video"; id: string } // id = VideoAsset.id
  | { type: "srt"; id: string } // id = SrtAsset.id
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
  /** ＋ 加到 序列n(播放头处、默认参数) */
  onAddCard: (kind: string) => void;
  /** 设为画布参考视频 */
  onSetVideo: (src: string) => void;
  /** 设为口播视频 */
  onSetCam: (src: string) => void;
  /** 用作本期字幕稿 */
  onUseSrt: (name: string, lines: SrtLine[]) => void;
  /** 点了字幕里的某一句 */
  onSeek: (t: number) => void;
  /** 悬停到某个素材(null = 移开 / 开始拖动 / 列表滚动了);anchor = 列表项的 getBoundingClientRect() */
  onHover: (item: LibrarySelection, anchor: DOMRect | null) => void;
  /** true 时接管 ↑↓(素材库分页显示时);false 时不挂键盘监听 */
  hotkeys: boolean;
}

/** m:ss(总时长) */
function fmtDuration(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

/** m:ss.s(时间码,和编辑台字幕稿一致) */
function fmtT(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** mm-dd hh:mm */
function fmtAddedAt(iso: string) {
  try {
    const d = new Date(iso);
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "";
  }
}

/** 同一条视频:忽略 ?v= 版本号只比路径(画布上的 src 会带版本号,登记表里的不一定带) */
function samePath(a?: string | null, b?: string | null) {
  if (!a || !b) return false;
  return a.split("?")[0] === b.split("?")[0];
}

export function LibraryTab({
  activeTrack,
  trackNames,
  srtName,
  curT,
  cardSpans,
  videoSrc,
  camSrc,
  onAddCard,
  onSetVideo,
  onSetCam,
  onUseSrt,
  onSeek,
  onHover,
  hotkeys,
}: LibraryTabProps) {
  const [videoAssets, setVideoAssets] = useState<VideoAsset[]>([]);
  const [srtAssets, setSrtAssets] = useState<SrtAsset[]>([]);
  const [selection, setSelection] = useState<LibrarySelection>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---------------- 登记表:挂载读一次,之后跟着变更刷新 ---------------- */
  const refresh = useCallback(() => {
    const vs = listVideoAssets();
    const ss = listSrtAssets();
    setVideoAssets(vs);
    setSrtAssets(ss);
    // 删掉的正好是选中的那条就清掉选择
    setSelection((s) => {
      if (s?.type === "video" && !vs.some((v) => v.id === s.id)) return null;
      if (s?.type === "srt" && !ss.some((a) => a.id === s.id)) return null;
      return s;
    });
  }, []);

  useEffect(() => {
    refresh();
    return subscribeAssets(refresh);
  }, [refresh]);

  /* ---------------- 悬停:只报给 App,自己不渲染浮窗 ---------------- */
  const hoverItemRef = useRef<LibrarySelection>(null);
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onHoverRef.current = onHover;
  });

  const emitHover = (item: LibrarySelection, anchor: DOMRect | null) => {
    // 已经是「没悬停」就不用再报一遍(滚动时每帧都会调到这里)
    if (item === null && hoverItemRef.current === null) return;
    hoverItemRef.current = item;
    onHover(item, anchor);
  };

  // 分页切走 / 组件卸载:别把预览留在屏幕上
  useEffect(
    () => () => {
      if (hoverItemRef.current !== null) {
        hoverItemRef.current = null;
        onHoverRef.current(null, null);
      }
    },
    [],
  );

  /* ---------------- 动效卡:搜索 + 标签 ---------------- */
  const [fxQuery, setFxQuery] = useState("");
  const fxKw = fxQuery.trim().toLowerCase();

  const fxGroups = useMemo(() => {
    const kw = fxKw;
    const hit = (e: EffectDef<any>) =>
      !kw ||
      e.id.toLowerCase().includes(kw) ||
      e.name.toLowerCase().includes(kw) ||
      e.description.toLowerCase().includes(kw) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(kw));
    return EFFECT_GROUPS.map((g) => ({
      ...g,
      // 组名命中就整组保留(搜「数据指标」= 看这一组)
      effects: kw && g.title.toLowerCase().includes(kw) ? g.effects : g.effects.filter(hit),
    })).filter((g) => g.effects.length > 0);
  }, [fxKw]);

  const [dragId, setDragId] = useState<string | null>(null);

  /* ---------------- ↑↓:动效卡 → 视频 → 字幕 一条扁平列表 ---------------- */
  useEffect(() => {
    if (!hotkeys) return;
    const items: Exclude<LibrarySelection, null>[] = [
      ...fxGroups.flatMap((g) => g.effects.map((e) => ({ type: "effect" as const, id: e.id }))),
      ...videoAssets.map((v) => ({ type: "video" as const, id: v.id })),
      ...srtAssets.map((a) => ({ type: "srt" as const, id: a.id })),
    ];
    if (items.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const el = e.target as HTMLElement;
      // 输入框里的 ↑↓ 让位(参数面板那些数字框);搜索框例外,搜完能直接用方向键挑
      const inSearch = el.closest(".fx-search") !== null;
      if (!inSearch && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      e.preventDefault(); // 否则浏览器会顺手滚一下列表
      const cur = items.findIndex((it) => it.type === selection?.type && it.id === selection.id);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = cur < 0 ? 0 : Math.min(Math.max(cur + step, 0), items.length - 1);
      const pick = items[next];
      if (pick.type !== selection?.type || pick.id !== selection.id) setSelection(pick);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, fxGroups, videoAssets, srtAssets, selection]);

  // 选中的项滚进可视区(键盘连按时不会走丢)
  useEffect(() => {
    listRef.current?.querySelector(".fx-item.is-on")?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  /* ---------------- 视频素材 ---------------- */
  const [videoImporting, setVideoImporting] = useState(false);
  const [videoErr, setVideoErr] = useState("");
  const videoFileRef = useRef<HTMLInputElement>(null);

  const handleImportVideo = async (file: File | null) => {
    if (!file) return;
    setVideoImporting(true);
    setVideoErr("");
    try {
      const asset = await importVideoFile(file);
      setVideoAssets(listVideoAssets());
      setSelection({ type: "video", id: asset.id });
    } catch (err) {
      setVideoErr(err instanceof Error ? err.message : String(err));
    } finally {
      setVideoImporting(false);
      if (videoFileRef.current) videoFileRef.current.value = "";
    }
  };

  /* ---------------- 字幕素材 ---------------- */
  const [srtImporting, setSrtImporting] = useState(false);
  const [srtErr, setSrtErr] = useState("");
  const srtFileRef = useRef<HTMLInputElement>(null);

  const handleImportSrt = async (file: File | null) => {
    if (!file) return;
    setSrtImporting(true);
    setSrtErr("");
    try {
      const asset = await importSrtFile(file);
      setSrtAssets(listSrtAssets());
      setSelection({ type: "srt", id: asset.id });
    } catch (err) {
      setSrtErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSrtImporting(false);
      if (srtFileRef.current) srtFileRef.current.value = "";
    }
  };

  /* ---------------- 选中的三种东西 ---------------- */
  const selectedEffect = selection?.type === "effect" ? EFFECTS.find((e) => e.id === selection.id) : undefined;
  const selectedVideo = selection?.type === "video" ? videoAssets.find((v) => v.id === selection.id) : undefined;
  const selectedSrt = selection?.type === "srt" ? srtAssets.find((a) => a.id === selection.id) : undefined;

  // 展开的字幕:播放头落在哪句(换句了才滚一次,别每帧都滚)
  const nowIdx = selectedSrt ? selectedSrt.lines.findIndex((l) => curT >= l.start && curT < l.end) : -1;
  const selectedSrtId = selectedSrt?.id ?? "";
  useEffect(() => {
    if (nowIdx < 0) return;
    listRef.current?.querySelector(".lib-srt-lines .srt-line.is-now")?.scrollIntoView({ block: "nearest" });
  }, [nowIdx, selectedSrtId]);

  const isRefVideo = selectedVideo ? samePath(selectedVideo.src, videoSrc) : false;
  const isCamVideo = selectedVideo ? samePath(selectedVideo.src, camSrc) : false;
  const srtInUse = !!selectedSrt && !!srtName && srtName === selectedSrt.name;

  let fxIdx = 0;

  return (
    <div className="lib-tab">
      <div className="fx-search">
        <input
          className="ctrl-input"
          type="search"
          placeholder="🔍 搜卡片:名字 / 用途 / 手感,如 数字、引用、发光、故障"
          value={fxQuery}
          onChange={(e) => setFxQuery(e.target.value)}
        />
      </div>
      <div className="fx-tagbar">
        {(Object.keys(VISUAL_TAGS) as VisualTag[]).map((t) => (
          <button
            key={t}
            className={`fx-tag ${fxKw === t.toLowerCase() ? "is-on" : ""}`}
            title={VISUAL_TAGS[t]}
            onClick={() => setFxQuery(fxKw === t.toLowerCase() ? "" : t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div
        className="fx-list"
        ref={listRef}
        onMouseLeave={() => emitHover(null, null)}
        onScroll={() => emitHover(null, null)}
      >
        {fxGroups.length === 0 ? (
          <div className="fx-empty">没有匹配「{fxQuery}」的卡片,换个词试试</div>
        ) : (
          fxGroups.map((g) => (
            <div className="fx-group" key={g.title}>
              <div className="fx-group-title">
                {g.title}
                <span className="fx-group-count">{g.effects.length}</span>
              </div>
              {g.effects.map((e) => {
                fxIdx += 1;
                const on = selection?.type === "effect" && selection.id === e.id;
                return (
                  <button
                    key={e.id}
                    className={`fx-item ${on ? "is-on" : ""} ${dragId === e.id ? "is-dragging" : ""}`}
                    onClick={() => setSelection({ type: "effect", id: e.id })}
                    onMouseEnter={(ev) =>
                      emitHover({ type: "effect", id: e.id }, ev.currentTarget.getBoundingClientRect())
                    }
                    draggable
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData("application/x-overlay-effect", e.id);
                      ev.dataTransfer.effectAllowed = "copy";
                      setDragId(e.id);
                      emitHover(null, null); // 拖动时不显示预览
                    }}
                    onDragEnd={() => setDragId(null)}
                    title="拖到时间轴 = 加到那条轨道"
                  >
                    <span className="fx-idx">{String(fxIdx).padStart(2, "0")}</span>
                    <span className="fx-meta">
                      <span className="fx-name">
                        <i className="fx-dot" style={{ background: kindColor(e.id) }} />
                        {e.name}
                      </span>
                      <span className="fx-desc">{e.description}</span>
                      {e.tags?.length ? (
                        <span className="fx-tags">
                          {e.tags.map((t) => (
                            <span
                              key={t}
                              className={`fx-tag ${fxKw === t.toLowerCase() ? "is-on" : ""}`}
                              role="button"
                              tabIndex={-1}
                              title={`只看「${t}」的卡`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setFxQuery(fxKw === t.toLowerCase() ? "" : t);
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}

        <div className="fx-group">
          <div className="fx-group-title">
            视频素材
            <span className="fx-group-count">{videoAssets.length}</span>
          </div>
          <input
            ref={videoFileRef}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={(e) => handleImportVideo(e.target.files?.[0] ?? null)}
          />
          <button
            className="video-btn lib-import-btn"
            disabled={videoImporting}
            onClick={() => videoFileRef.current?.click()}
          >
            {videoImporting ? "导入中…" : "＋ 导入视频"}
          </button>
          {videoErr ? <div className="lib-err">{videoErr}</div> : null}
          {videoAssets.length === 0 && !videoImporting ? (
            <div className="lib-empty">还没有视频素材。导入的视频会落到 public/_media,导出时也读得到。</div>
          ) : null}
          {videoAssets.map((asset) => {
            const on = selection?.type === "video" && selection.id === asset.id;
            const isRef = samePath(asset.src, videoSrc);
            const isCam = samePath(asset.src, camSrc);
            const dur = asset.durationSec ? fmtT(asset.durationSec) : "";
            const date = new Date(asset.addedAt).toLocaleDateString();
            return (
              <div
                key={asset.id}
                role="button"
                tabIndex={0}
                className={`fx-item lib-item ${on ? "is-on" : ""}`}
                title={asset.name}
                onClick={() => setSelection({ type: "video", id: asset.id })}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelection({ type: "video", id: asset.id });
                  }
                }}
                onMouseEnter={(ev) =>
                  emitHover({ type: "video", id: asset.id }, ev.currentTarget.getBoundingClientRect())
                }
              >
                <span className="lib-item-main">
                  <span className="lib-item-name">
                    <span className="lib-item-title">{asset.name}</span>
                    {isRef ? <span className="lib-badge">参考视频</span> : null}
                    {isCam ? <span className="lib-badge">口播</span> : null}
                  </span>
                  <span className="lib-item-meta">
                    {dur ? `${dur} · ` : ""}
                    {date}
                  </span>
                </span>
                <button
                  className="lib-del"
                  title="删除登记(不删文件)"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    removeVideoAsset(asset.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>

        <div className="fx-group">
          <div className="fx-group-title">
            字幕素材
            <span className="fx-group-count">{srtAssets.length}</span>
          </div>
          <input
            ref={srtFileRef}
            type="file"
            accept=".srt"
            style={{ display: "none" }}
            onChange={(e) => handleImportSrt(e.target.files?.[0] ?? null)}
          />
          <button
            className="video-btn lib-import-btn"
            disabled={srtImporting}
            onClick={() => srtFileRef.current?.click()}
          >
            {srtImporting ? "导入中…" : "＋ 导入 SRT"}
          </button>
          {srtErr ? <div className="lib-err">{srtErr}</div> : null}
          {srtAssets.length === 0 && !srtImporting ? (
            <div className="lib-empty">还没有字幕素材。导入 .srt 之后可以选一份「用作本期字幕稿」。</div>
          ) : null}
          {srtAssets.map((asset) => {
            const on = selection?.type === "srt" && selection.id === asset.id;
            const inUse = !!srtName && srtName === asset.name;
            return (
              <Fragment key={asset.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className={`fx-item lib-item ${on ? "is-on" : ""}`}
                  title={asset.name}
                  onClick={() => setSelection({ type: "srt", id: asset.id })}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setSelection({ type: "srt", id: asset.id });
                    }
                  }}
                  onMouseEnter={(ev) =>
                    emitHover({ type: "srt", id: asset.id }, ev.currentTarget.getBoundingClientRect())
                  }
                >
                  <span className="lib-item-main">
                    <span className="lib-item-name">
                      <span className="lib-item-title">{asset.name}</span>
                      {inUse ? <span className="lib-badge">使用中</span> : null}
                    </span>
                    <span className="lib-item-meta">
                      {asset.lines.length} 句 · {fmtDuration(srtDuration(asset.lines))} · {fmtAddedAt(asset.addedAt)}
                    </span>
                  </span>
                  <button
                    className="lib-del"
                    title="删除登记(不删文件)"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      removeSrtAsset(asset.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
                {on ? (
                  <div className="lib-srt-lines">
                    {asset.lines.map((line, i) => {
                      const isNow = curT >= line.start && curT < line.end;
                      const isCovered = (cardSpans ?? []).some(([s, e]) => s < line.end && e > line.start);
                      return (
                        <button
                          key={i}
                          className={`srt-line ${isNow ? "is-now" : ""}`}
                          onClick={() => onSeek(line.start + 0.01)}
                          title={isCovered ? "这句已有卡覆盖" : "这句还没有卡"}
                        >
                          <span className="srt-time">
                            {fmtT(line.start)}
                            <span className={`srt-dot ${isCovered ? "is-covered" : ""}`} />
                          </span>
                          <span className="srt-text">{line.text}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="lib-foot">
        {selectedEffect ? (
          <>
            <button className="lib-btn-primary" onClick={() => onAddCard(selectedEffect.id)}>
              ＋ 加到 {trackLabel(activeTrack, trackNames)}
            </button>
            <span className="lib-hint">或直接拖到时间轴的任意位置</span>
          </>
        ) : selectedVideo ? (
          <>
            <div className="lib-foot-row">
              <button className="video-btn" disabled={isRefVideo} onClick={() => onSetVideo(selectedVideo.src)}>
                {isRefVideo ? "✓ 参考视频" : "设为画布参考视频"}
              </button>
              <button className="video-btn" disabled={isCamVideo} onClick={() => onSetCam(selectedVideo.src)}>
                {isCamVideo ? "✓ 口播视频" : "设为口播视频"}
              </button>
            </div>
            <span className="lib-hint">{selectedVideo.name}</span>
          </>
        ) : selectedSrt ? (
          <>
            <button
              className="video-btn lib-btn-wide"
              disabled={srtInUse}
              onClick={() => onUseSrt(selectedSrt.name, selectedSrt.lines)}
            >
              {srtInUse ? "✓ 使用中" : "用作本期字幕稿"}
            </button>
            <span className="lib-hint">
              {selectedSrt.lines.length} 句 · {fmtDuration(srtDuration(selectedSrt.lines))}
            </span>
          </>
        ) : (
          <span className="lib-hint">点一个素材看操作;动效卡可以直接拖到时间轴</span>
        )}
      </div>
    </div>
  );
}

export default LibraryTab;
