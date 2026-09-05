import "./StageControls.css";

interface StageControlsProps {
  curT: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  onPlayPause: () => void;
  onReset: () => void;
  onToggleMute: () => void;
  showGuides: boolean;
  onToggleGuides: () => void;
  showPerson: boolean;
  onTogglePerson: () => void;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/**
 * 预览画面下面的操作栏:归零 / 播放暂停 / 声音 + 当前时间读数。
 * 这些原来散在顶栏和时间轴里,按专业剪辑软件的习惯收到画面正下方。
 */
export function StageControls({
  curT,
  duration,
  playing,
  muted,
  onPlayPause,
  onReset,
  onToggleMute,
  showGuides,
  onToggleGuides,
  showPerson,
  onTogglePerson,
}: StageControlsProps) {
  const noDur = duration <= 0;
  return (
    <div className="stc" role="toolbar" aria-label="播放控制">
      <div className="stc-group">
        <button className="stc-btn" onClick={onReset} title="回到 0 秒并暂停">
          ⏮ 归零
        </button>
        <button
          className={`stc-btn stc-btn--play ${playing ? "is-on" : ""}`}
          onClick={onPlayPause}
          disabled={noDur}
          title={playing ? "暂停(空格)" : "播放(空格)"}
        >
          {playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
        <button
          className={`stc-btn ${muted ? "is-muted" : ""}`}
          onClick={onToggleMute}
          title={muted ? "已静音,点击打开视频声音" : "有声音,点击静音"}
        >
          {muted ? "🔇 静音" : "🔊 声音"}
        </button>
      </div>
      <div className="stc-time" title="当前时间 / 总时长">
        <span className="stc-cur">{fmt(curT)}</span>
        <span className="stc-sep">/</span>
        <span className="stc-dur">{fmt(duration)}</span>
      </div>
      <div className="stc-divider" />
      <div className="stc-group">
        <button
          className={`stc-btn ${showGuides ? "is-on" : ""}`}
          onClick={onToggleGuides}
          aria-pressed={showGuides}
          title="安全区参考线(只影响预览,不进导出)"
        >
          ▦ 安全区
        </button>
        <button
          className={`stc-btn ${showPerson ? "is-on" : ""}`}
          onClick={onTogglePerson}
          aria-pressed={showPerson}
          title="人物占位(只影响预览)"
        >
          👤 人物占位
        </button>
      </div>
    </div>
  );
}
