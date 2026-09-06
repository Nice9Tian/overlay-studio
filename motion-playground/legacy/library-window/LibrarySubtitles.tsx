import { useState, useEffect, useRef } from "react";
import type { SrtAsset } from "./assets";
import { listSrtAssets, importSrtFile, removeSrtAsset, srtDuration } from "./assets";
import { busSubscribe } from "./bus";
import "./LibrarySubtitles.css";

function fmtDuration(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fmtT(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    const hh = d.getHours().toString().padStart(2, "0");
    const min = d.getMinutes().toString().padStart(2, "0");
    return `${mm}-${dd} ${hh}:${min}`;
  } catch {
    return "";
  }
}

export function SubtitleAssetList(props: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  inUseName?: string;
  /** 本组件自己改了登记表(导入 / 删除)之后通知宿主重读 —— bus 的 assets-changed 不会回送给本窗口 */
  onChange?: () => void;
}) {
  const [assets, setAssets] = useState<SrtAsset[]>(() => listSrtAssets());
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => setAssets(listSrtAssets());

  useEffect(() => {
    return busSubscribe((msg) => {
      if (msg.type === "assets-changed") {
        refresh();
      }
    });
  }, []);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setErrorMsg("");
    try {
      const asset = await importSrtFile(file);
      refresh();
      props.onChange?.();
      props.onSelect(asset.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg || "导入失败");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleRemove = (e: React.SyntheticEvent, id: string) => {
    e.stopPropagation();
    removeSrtAsset(id);
    refresh();
    props.onChange?.();
  };

  return (
    <div className="lsub-group">
      <div className="lsub-group-title">字幕素材</div>
      <div className="lsub-list">
        {assets.length === 0 ? (
          <div className="lsub-empty">还没有字幕素材,请点击下方按钮导入 .srt 文件。</div>
        ) : (
          assets.map((a) => (
            <button
              key={a.id}
              className={`lsub-item ${a.id === props.selectedId ? "is-on" : ""}`}
              onClick={() => props.onSelect(a.id)}
            >
              <div className="lsub-item-main">
                <span className="lsub-item-name">{a.name}</span>
                {props.inUseName && props.inUseName === a.name && <span className="lsub-item-tag">使用中</span>}
              </div>
              <div className="lsub-item-meta">
                {a.lines.length} 句 · {fmtDuration(srtDuration(a.lines))} · {formatDate(a.addedAt)}
              </div>
              <div
                className="lsub-item-del"
                role="button"
                tabIndex={0}
                aria-label="删除登记"
                onClick={(e) => handleRemove(e, a.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleRemove(e, a.id);
                  }
                }}
                title="删除"
              >
                ✕
              </div>
            </button>
          ))
        )}
      </div>
      <div className="lsub-import-wrap">
        <button
          className="video-btn lsub-import-btn"
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          {importing ? "导入中……" : "＋ 导入 SRT"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".srt"
          style={{ display: "none" }}
          onChange={handleImport}
        />
        {errorMsg && <div className="lsub-error">{errorMsg}</div>}
      </div>
    </div>
  );
}

export function SubtitleAssetView(props: {
  asset: SrtAsset;
  curT?: number;
  cardSpans?: [number, number][];
  inUse?: boolean;
  disabled?: boolean;
  onUse: (asset: SrtAsset) => void;
  onSeek: (t: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (props.curT === undefined) return;
    const active = containerRef.current?.querySelector(".srt-line.is-now");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [props.curT, props.asset.id]);

  const dur = fmtDuration(srtDuration(props.asset.lines));

  return (
    <div className="lsub-view">
      <div className="lsub-view-head">
        <div className="lsub-view-info">
          <div className="lsub-view-name">{props.asset.name}</div>
          <div className="lsub-view-meta">
            {props.asset.lines.length} 句 · {dur}
          </div>
        </div>
        <div className="lsub-view-action">
          <button
            className="video-btn lsub-use-btn"
            disabled={props.inUse || props.disabled}
            title={props.disabled ? "编辑台窗口没开" : ""}
            onClick={() => props.onUse(props.asset)}
          >
            {props.inUse ? "✓ 使用中" : "用作本期字幕稿"}
          </button>
          {props.disabled && <div className="lsub-view-hint">编辑台窗口没开</div>}
        </div>
      </div>
      <div className="lsub-lines" ref={containerRef}>
        {props.asset.lines.map((line, i) => {
          const isNow =
            props.curT !== undefined && props.curT >= line.start && props.curT < line.end;
          const isCovered =
            props.cardSpans &&
            props.cardSpans.some(([s, e]) => s < line.end && e > line.start);
          return (
            <button
              key={i}
              className={`srt-line ${isNow ? "is-now" : ""}`}
              onClick={() => props.onSeek(line.start + 0.01)}
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
    </div>
  );
}
