/**
 * 素材库窗口本体(契约:LIBRARY-DESIGN.md)。
 *
 * 左列:动效卡(搜索 + 标签 + 分组列表,可拖到时间轴)/ 视频素材 / 字幕素材;
 * 右侧:预览器(LibraryPreview,播放 / 暂停 / 停止 + 可拖时间轴)+ 动作栏 + 右下角「…」滑出参数面板;
 * 选中字幕素材时右侧换成句子列表(SubtitleAssetView)。
 *
 * 两种宿主:
 * - embedded(single 模式):编辑台里的全屏浮层,动作全走 props 回调,编辑台状态从 props.editorState 来;
 * - 独立窗口(multi 模式,?library=1):动作走 bus 广播给编辑台,编辑台状态从 bus 的 editor-state 来,
 *   没收到过编辑台的消息就当「编辑台窗口没开」,动作按钮禁用。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { EffectDef, VisualTag } from "../effects/types";
import { VISUAL_TAGS } from "../effects/types";
import { EFFECT_GROUPS, EFFECTS } from "../effects/registry";
import { kindColor } from "../effects/kindColor";
import type { SrtLine } from "../overlay/srt";
import { busSend, busSubscribe, type BusMessage } from "./bus";
import {
  listVideoAssets,
  removeVideoAsset,
  importVideoFile,
  listSrtAssets,
  type VideoAsset,
  type SrtAsset,
} from "./assets";
import { LibraryPreview } from "./LibraryPreview";
import { SubtitleAssetList, SubtitleAssetView } from "./LibrarySubtitles";
import { ParamsPanel } from "../components/ParamsPanel";
import { trackLabel } from "../overlay/cardLabel";
import "./LibraryWindow.css";

/** 编辑台状态:嵌入态由 App 传 props,独立窗口从 bus 的 editor-state 拿;字段和 bus 消息保持一致 */
export type LibraryEditorState = Omit<Extract<BusMessage, { type: "editor-state" }>, "type">;

export interface LibraryWindowProps {
  /** 嵌入模式(single):作为编辑台里的全屏浮层渲染,带关闭按钮和 Esc 关闭 */
  embedded?: boolean;
  onClose?: () => void;
  /** 嵌入模式下由编辑台直接接收(multi 模式走 bus,这些不传) */
  onAddCard?: (kind: string, params: Record<string, unknown>, track?: number) => void;
  onSetCam?: (src: string) => void;
  onSetVideo?: (src: string) => void;
  /** 嵌入模式:「用作本期字幕稿」 */
  onSetSrt?: (name: string, lines: SrtLine[]) => void;
  /** 嵌入模式:点了字幕里的某一句 → 编辑台播放头跳过去 */
  onSeek?: (t: number) => void;
  /** 嵌入模式下编辑台传进来的状态;multi 模式从 bus 的 editor-state 消息里拿 */
  editorState?: LibraryEditorState;
}

type SelectionState =
  | { type: "effect"; id: string }
  | { type: "video"; id: string }
  | { type: "srt"; id: string }
  | null;

export function LibraryWindow(props: LibraryWindowProps) {
  const { embedded, onClose, onAddCard, onSetCam, onSetVideo, onSetSrt, onSeek, editorState: propsEditorState } = props;

  const [remoteState, setRemoteState] = useState<LibraryEditorState | null>(null);
  const [connected, setConnected] = useState(false);
  const [videoAssets, setVideoAssets] = useState<VideoAsset[]>([]);
  const [srtAssets, setSrtAssets] = useState<SrtAsset[]>([]);
  const [selection, setSelection] = useState<SelectionState>(null);

  useEffect(() => {
    setVideoAssets(listVideoAssets());
    setSrtAssets(listSrtAssets());
  }, []);

  // 别的窗口改了登记表(bus 不回送给自己,本窗口的改动在各自的处理函数里刷新)
  useEffect(
    () =>
      busSubscribe((msg) => {
        if (msg.type === "assets-changed") {
          setVideoAssets(listVideoAssets());
          setSrtAssets(listSrtAssets());
        }
      }),
    [],
  );

  useEffect(() => {
    if (embedded) {
      setConnected(true);
      return;
    }
    const off = busSubscribe((msg) => {
      if (msg.type === "editor-state") {
        setRemoteState(msg);
        setConnected(true);
      } else if (msg.type === "hello-ack") {
        setConnected(true);
      }
    });
    busSend({ type: "hello", from: "library" });
    return off;
  }, [embedded]);

  const editorState = embedded ? propsEditorState : (remoteState ?? undefined);
  const activeTrack = editorState?.activeTrack ?? 1;
  const trackNames = editorState?.trackNames;

  /* ---------------- 动效卡列表 ---------------- */
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
      effects: kw && g.title.toLowerCase().includes(kw) ? g.effects : g.effects.filter(hit),
    })).filter((g) => g.effects.length > 0);
  }, [fxKw]);

  const [dragId, setDragId] = useState<string | null>(null);
  const fxListRef = useRef<HTMLDivElement>(null);

  // ↑↓ 在动效卡之间走(和编辑台左栏一致);搜索框里也能用
  useEffect(() => {
    const ids = fxGroups.flatMap((g) => g.effects.map((x) => x.id));
    if (ids.length === 0) return;
    const curId = selection?.type === "effect" ? selection.id : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const el = e.target as HTMLElement;
      const inFxSearch = el.closest(".fx-search") !== null;
      if (!inFxSearch && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      e.preventDefault();
      const cur = ids.indexOf(curId ?? "");
      const next = cur < 0 ? 0 : Math.min(Math.max(cur + (e.key === "ArrowDown" ? 1 : -1), 0), ids.length - 1);
      if (ids[next] !== curId) setSelection({ type: "effect", id: ids[next] });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fxGroups, selection]);

  useEffect(() => {
    fxListRef.current?.querySelector(".fx-item.is-on")?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  /* ---------------- 视频素材 ---------------- */
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImportVideo = async (file: File | null) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const asset = await importVideoFile(file);
      setVideoAssets(listVideoAssets());
      setSelection({ type: "video", id: asset.id });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleRemoveVideo = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeVideoAsset(id);
    setVideoAssets(listVideoAssets());
  };

  /* ---------------- 字幕素材 ---------------- */
  // 列表组件自己导入 / 删登记,改完通过 onChange 通知这里重读;被删的正好是选中的就清掉选择
  const refreshSrt = () => {
    const list = listSrtAssets();
    setSrtAssets(list);
    setSelection((s) => (s?.type === "srt" && !list.some((a) => a.id === s.id) ? null : s));
  };

  /* ---------------- 参数(按 kind 记,只活在本窗口) ---------------- */
  const [paramsById, setParamsById] = useState<Record<string, Record<string, unknown>>>({});

  const getParams = (kind: string) => {
    if (paramsById[kind]) return paramsById[kind];
    const def = EFFECTS.find((e) => e.id === kind);
    return def ? { ...def.defaults } : {};
  };

  const handleParamChange = (kind: string, key: string, value: unknown) => {
    setParamsById((prev) => ({
      ...prev,
      [kind]: { ...(prev[kind] ?? EFFECTS.find((e) => e.id === kind)?.defaults ?? {}), [key]: value },
    }));
  };

  const handleParamChangeMany = (kind: string, patch: Record<string, unknown>) => {
    setParamsById((prev) => ({
      ...prev,
      [kind]: { ...(prev[kind] ?? EFFECTS.find((e) => e.id === kind)?.defaults ?? {}), ...patch },
    }));
  };

  const [paramsOpen, setParamsOpen] = useState(false);

  // Esc:先收参数抽屉,再关浮层(嵌入态)
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (paramsOpen) {
        setParamsOpen(false);
        e.stopPropagation();
      } else if (embedded && onClose) {
        onClose();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [paramsOpen, embedded, onClose]);

  /* ---------------- 渲染 ---------------- */
  const selectedEffectDef = selection?.type === "effect" ? EFFECTS.find((e) => e.id === selection.id) : undefined;
  const selectedVideo = selection?.type === "video" ? videoAssets.find((v) => v.id === selection.id) : undefined;
  const selectedSrt = selection?.type === "srt" ? srtAssets.find((a) => a.id === selection.id) : undefined;

  const content = (
    <div className={embedded ? "lw-panel" : "lw-standalone"}>
      <div className="lw-header">
        <div className="lw-title">素材库</div>
        {embedded && (
          <button className="lw-close-btn" onClick={onClose} title="关闭(Esc)">
            ✕
          </button>
        )}
      </div>
      <div className="lw-left">
        <div className="lw-left-head">
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
        </div>
        <div className="lw-list-wrap fx-list" ref={fxListRef}>
          {fxGroups.length === 0 ? (
            <div className="fx-empty">没有匹配「{fxQuery}」的卡片,换个词试试</div>
          ) : (
            (() => {
              let idx = 0;
              return fxGroups.map((g) => (
                <div className="fx-group" key={g.title}>
                  <div className="fx-group-title">
                    {g.title}
                    <span className="fx-group-count">{g.effects.length}</span>
                  </div>
                  {g.effects.map((e) => {
                    idx += 1;
                    return (
                      <button
                        key={e.id}
                        className={`fx-item ${selection?.type === "effect" && selection.id === e.id ? "is-on" : ""} ${dragId === e.id ? "is-dragging" : ""}`}
                        onClick={() => setSelection({ type: "effect", id: e.id })}
                        draggable
                        onDragStart={(ev) => {
                          ev.dataTransfer.setData("application/x-overlay-effect", e.id);
                          ev.dataTransfer.effectAllowed = "copy";
                          setDragId(e.id);
                        }}
                        onDragEnd={() => setDragId(null)}
                        title="拖到时间轴 = 加到那条轨道"
                      >
                        <span className="fx-idx">{String(idx).padStart(2, "0")}</span>
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
              ));
            })()
          )}

          <div className="fx-group">
            <div className="fx-group-title">
              视频素材
              <span className="fx-group-count">{videoAssets.length}</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => handleImportVideo(e.target.files?.[0] ?? null)}
            />
            <button className="lw-video-add-btn" disabled={importing} onClick={() => fileRef.current?.click()}>
              {importing ? "导入中…" : "＋ 导入视频"}
            </button>
            {importError && <div className="lw-video-err">{importError}</div>}
            {videoAssets.map((asset) => {
              const durationStr = asset.durationSec
                ? `${Math.floor(asset.durationSec / 60)}:${(asset.durationSec % 60).toFixed(1).padStart(4, "0")}`
                : "";
              const dateStr = new Date(asset.addedAt).toLocaleDateString();
              return (
                <div
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  className={`fx-item lw-video-asset ${selection?.type === "video" && selection.id === asset.id ? "is-on" : ""}`}
                  onClick={() => setSelection({ type: "video", id: asset.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection({ type: "video", id: asset.id });
                    }
                  }}
                >
                  <div className="lw-video-asset-info">
                    <span className="lw-video-asset-name">{asset.name}</span>
                    <span className="lw-video-asset-meta">
                      {durationStr ? `${durationStr} · ` : ""}
                      {dateStr}
                    </span>
                  </div>
                  <button className="lw-video-del" title="删除登记(不删文件)" onClick={(e) => handleRemoveVideo(e, asset.id)}>
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          <SubtitleAssetList
            selectedId={selection?.type === "srt" ? selection.id : null}
            onSelect={(id) => {
              setSrtAssets(listSrtAssets());
              setSelection({ type: "srt", id });
            }}
            onChange={refreshSrt}
            inUseName={editorState?.srtName}
          />
        </div>
      </div>

      <div className="lw-right">
        {selectedSrt ? (
          <div className="lw-srt-area">
            <SubtitleAssetView
              asset={selectedSrt}
              curT={editorState?.curT}
              cardSpans={editorState?.cardSpans}
              inUse={!!editorState?.srtName && editorState.srtName === selectedSrt.name}
              disabled={!connected}
              onUse={(a) => {
                if (embedded) onSetSrt?.(a.name, a.lines);
                else busSend({ type: "set-srt", name: a.name, lines: a.lines });
              }}
              onSeek={(t) => {
                if (embedded) onSeek?.(t);
                else busSend({ type: "seek", t });
              }}
            />
          </div>
        ) : (
          <>
            <div className="lw-preview-area">
              {!selectedEffectDef && !selectedVideo ? (
                <div className="lw-empty-state">在左侧选一个素材,这里预览</div>
              ) : (
                <LibraryPreview
                  effect={selectedEffectDef}
                  params={selectedEffectDef ? getParams(selectedEffectDef.id) : undefined}
                  videoSrc={selectedVideo?.src}
                />
              )}
            </div>
            <div className="lw-actions">
              {selectedEffectDef && (
                <>
                  <button
                    className="lw-btn-primary"
                    disabled={!connected}
                    onClick={() => {
                      const params = getParams(selectedEffectDef.id);
                      if (embedded) onAddCard?.(selectedEffectDef.id, params, activeTrack);
                      else busSend({ type: "add-card", kind: selectedEffectDef.id, params, track: activeTrack });
                    }}
                  >
                    ＋ 加到 {trackLabel(activeTrack, trackNames)}
                  </button>
                  {!connected && <span className="lw-disconnect-hint">编辑台窗口没开</span>}
                </>
              )}
              {selectedVideo && (
                <>
                  <button
                    className="lw-btn-secondary"
                    disabled={!connected}
                    onClick={() => {
                      if (embedded) onSetCam?.(selectedVideo.src);
                      else busSend({ type: "set-cam", src: selectedVideo.src });
                    }}
                  >
                    设为口播视频
                  </button>
                  <button
                    className="lw-btn-secondary"
                    disabled={!connected}
                    onClick={() => {
                      if (embedded) onSetVideo?.(selectedVideo.src);
                      else busSend({ type: "set-video", src: selectedVideo.src });
                    }}
                  >
                    设为画布参考视频
                  </button>
                  {!connected && <span className="lw-disconnect-hint">编辑台窗口没开</span>}
                </>
              )}
            </div>
            <button className="lw-params-btn" title="调整参数" onClick={() => setParamsOpen((o) => !o)}>
              …
            </button>
            <div className={`lw-params-drawer ${paramsOpen ? "is-open" : ""}`}>
              {selectedEffectDef ? (
                <ParamsPanel
                  effect={selectedEffectDef}
                  params={getParams(selectedEffectDef.id)}
                  onChange={(key, val) => handleParamChange(selectedEffectDef.id, key, val)}
                  onChangeMany={(patch) => handleParamChangeMany(selectedEffectDef.id, patch)}
                />
              ) : (
                <div className="pp-empty">先在左侧选一张动效卡,再来调参数</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return embedded ? <div className="lw-overlay">{content}</div> : content;
}

export default LibraryWindow;
