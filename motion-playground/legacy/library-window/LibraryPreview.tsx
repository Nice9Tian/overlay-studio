import { useEffect, useRef, useState } from 'react';
import type { EffectDef } from '../effects/types';
import { Canvas } from '../components/Canvas';

import '../effects/hud/hud.css';
import '../App.css';
import './LibraryPreview.css';

export interface LibraryPreviewProps {
  effect?: EffectDef<any>;
  params?: Record<string, unknown>;
  videoSrc?: string;
  theme?: 'dark' | 'light';
  skin?: string;
  docStyle?: string;
  font?: string;
  glow?: boolean;
}

type FxWin = Window & { __fxExportMs?: number };

const ENTRY_MS = 1200;
const TOTAL_MS = ENTRY_MS + 8000;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function LibraryPreview({
  effect,
  params,
  videoSrc,
  theme,
  skin,
  docStyle,
  font,
  glow,
}: LibraryPreviewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [playing, setPlaying] = useState(false);
  const [curMs, setCurMs] = useState(0);
  const [vidDurSec, setVidDurSec] = useState(0);
  const [playToken, setPlayToken] = useState(1);

  const msRef = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;

  const isVideo = !!videoSrc;
  const isFx = !isVideo && !!effect;

  const initRef = useRef(false);
  if (!initRef.current) {
    initRef.current = true;
    if (isFx) {
      (window as FxWin).__fxExportMs = 0;
    }
  }

  const paramsKey = JSON.stringify(params ?? null);

  useEffect(() => {
    if (isFx) {
      msRef.current = 0;
      (window as FxWin).__fxExportMs = 0;
      setCurMs(0);
      setPlayToken((t) => t + 1);
      setPlaying(true);
    }
  }, [effect?.id, paramsKey, isFx]);

  useEffect(() => {
    if (!isFx) return;

    let raf: number;
    let last = -1;

    const tick = (now: number) => {
      if (last < 0) last = now;
      // rAF 在页面隐藏时不触发,performance.now 照走,加上限防止回来时瞬间快进到底
      const dt = Math.min(100, Math.max(0, now - last));
      last = now;

      if (playingRef.current) {
        msRef.current = Math.min(TOTAL_MS, msRef.current + dt);
        if (msRef.current >= TOTAL_MS) {
          setPlaying(false);
        }
        const anims = stageRef.current?.getAnimations({ subtree: true }) ?? [];
        for (const a of anims) {
          if (a.playState === 'paused') {
            try {
              a.play();
            } catch {
              // ignore
            }
          }
        }
      } else {
        const anims = stageRef.current?.getAnimations({ subtree: true }) ?? [];
        for (const a of anims) {
          if (a.playState === 'running') {
            try {
              a.pause();
            } catch {
              // ignore
            }
          }
        }
      }

      (window as FxWin).__fxExportMs = msRef.current;
      setCurMs(msRef.current);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      delete (window as FxWin).__fxExportMs;
    };
  }, [isFx]);

  const handlePlay = () => {
    if (isVideo) {
      videoRef.current?.play().catch(() => {});
    } else {
      if (msRef.current >= TOTAL_MS) {
        msRef.current = 0;
        (window as FxWin).__fxExportMs = 0;
        setCurMs(0);
        setPlayToken((t) => t + 1);
      }
    }
    setPlaying(true);
  };

  const handlePause = () => {
    if (isVideo) {
      videoRef.current?.pause();
    }
    setPlaying(false);
  };

  const handleStop = () => {
    if (isVideo) {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
      setPlaying(false);
    } else {
      msRef.current = 0;
      (window as FxWin).__fxExportMs = 0;
      setCurMs(0);
      setPlaying(false);
      setPlayToken((t) => t + 1);
    }
  };

  const handleSeek = (sec: number) => {
    if (isVideo) {
      if (videoRef.current) {
        videoRef.current.currentTime = sec;
      }
      setCurMs(sec * 1000);
    } else {
      const ms = sec * 1000;
      msRef.current = ms;
      (window as FxWin).__fxExportMs = ms;
      setCurMs(ms);
      const anims = stageRef.current?.getAnimations({ subtree: true }) ?? [];
      for (const a of anims) {
        try {
          a.currentTime = ms;
        } catch {
          // ignore
        }
        if (!playingRef.current) {
          try {
            a.pause();
          } catch {
            // ignore
          }
        }
      }
    }
  };

  if (!isVideo && !isFx) {
    return (
      <div className="lp-root">
        <div className="lp-placeholder">无预览内容</div>
      </div>
    );
  }

  const curSec = curMs / 1000;
  const totalSec = isVideo ? vidDurSec : TOTAL_MS / 1000;

  return (
    <div className="lp-root">
      <div className="lp-stage" ref={stageRef}>
        {isVideo ? (
          <video
            ref={videoRef}
            playsInline
            preload="metadata"
            src={videoSrc}
            onLoadedMetadata={(e) =>
              setVidDurSec(e.currentTarget.duration || 0)
            }
            onTimeUpdate={(e) =>
              setCurMs(e.currentTarget.currentTime * 1000)
            }
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <Canvas
            effect={effect!}
            params={{
              ...(params ?? effect!.defaults),
              theme: params?.theme ?? theme ?? 'dark',
            }}
            playToken={playToken}
            showGuides={false}
            showPerson={true}
            videoUrl={null}
            fxScale={1}
            skin={skin}
            docStyle={docStyle}
            font={font}
            glow={glow}
            overlayTheme={theme}
          />
        )}
      </div>
      <div className="lp-transport">
        <div className="lp-transport-group">
          <button
            className={`lp-btn lp-btn-play ${playing ? 'is-on' : ''}`}
            onClick={handlePlay}
            title="播放"
          >
            ▶ 播放
          </button>
          <button className="lp-btn" onClick={handlePause} title="暂停">
            ⏸ 暂停
          </button>
          <button className="lp-btn" onClick={handleStop} title="停止">
            ⏹ 停止
          </button>
        </div>
        <input
          type="range"
          className="lp-timeline"
          min={0}
          max={Math.max(0.1, totalSec)}
          step={0.05}
          value={curSec}
          onChange={(e) => handleSeek(Number(e.target.value))}
        />
        <div className="lp-time">
          <span className="lp-cur">{fmt(curSec)}</span>
          <span className="lp-sep">/</span>
          <span className="lp-dur">{fmt(totalSec)}</span>
        </div>
      </div>
    </div>
  );
}

export default LibraryPreview;
