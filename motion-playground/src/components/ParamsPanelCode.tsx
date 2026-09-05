import { useEffect, useMemo, useRef, useState } from "react";
import type { EffectDef } from "../effects/types";
import type { OverlayCard } from "../overlay/types";
import { trackLabel } from "../overlay/cardLabel";
import "./ParamsPanelCode.css";

/**
 * 右栏「代码」页:把当前卡片(或效果模板)当一段 JSON 直接看、直接改。
 *
 * 为什么不另起一套状态:面板已有的回调(onChangeMany / onTimeChange / onKindChange / onTrack)
 * 就是编排的唯一写入口,代码页只是把它们换了一种输入方式 —— 撤销、自动存档、体检都不用改。
 * 能改的字段:kind / start / end / track / params。id、seg、lintOff 只能看,改了会提示。
 */

interface Props {
  effect: EffectDef<any>;
  card?: OverlayCard | null;
  params: any;
  onChange: (key: string, value: unknown) => void;
  onChangeMany?: (patch: Record<string, unknown>) => void;
  onTimeChange?: (key: "start" | "end", value: number) => void;
  onKindChange?: (kind: string) => void;
  onTrack?: (track: number) => void;
  trackCount?: number;
}

/** 组件源码(只读):vite 的 ?raw 把 .tsx 当文本引进来,按需加载,不进主包 */
const SOURCES = import.meta.glob("../effects/**/*.tsx", { query: "?raw", import: "default" }) as Record<
  string,
  () => Promise<string>
>;

function snapshot(effect: EffectDef<any>, card: OverlayCard | null | undefined, params: any) {
  if (card) {
    const o: Record<string, unknown> = {
      id: card.id,
      kind: card.kind,
      start: card.start,
      end: card.end,
    };
    if (card.track !== undefined) o.track = card.track;
    if (card.seg !== undefined) o.seg = card.seg;
    if (card.lintOff !== undefined) o.lintOff = card.lintOff;
    o.params = params ?? {};
    return o;
  }
  return { kind: effect.id, params: params ?? {} };
}

function pretty(o: unknown) {
  return JSON.stringify(o, null, 2);
}

export function ParamsPanelCode({
  effect,
  card,
  params,
  onChange,
  onChangeMany,
  onTimeChange,
  onKindChange,
  onTrack,
  trackCount,
}: Props) {
  const current = useMemo(() => pretty(snapshot(effect, card, params)), [effect, card, params]);
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dirty = draft !== current;
  // 换了卡 / 外面(常规页、拖动)改了参数:草稿没动过就跟着刷新;动过就留着,别把人正在打的字冲掉
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (draft === lastCurrent.current) setDraft(current);
    lastCurrent.current = current;
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // 组件源码
  const [showSource, setShowSource] = useState(false);
  const [source, setSource] = useState<{ file: string; text: string } | null>(null);
  const [sourceErr, setSourceErr] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    setSourceErr(null);
    if (!showSource) return;
    let alive = true;
    (async () => {
      // 先按 name 找同名文件(ChapterBar → hud/ChapterBar.tsx),找不到再逐个文件搜 id
      const byName = Object.keys(SOURCES).find((p) => p.endsWith(`/${effect.name}.tsx`));
      const tryLoad = async (p: string) => ({ file: p.replace(/^\.\.\//, "src/"), text: await SOURCES[p]() });
      try {
        if (byName) {
          const r = await tryLoad(byName);
          if (alive) setSource(r);
          return;
        }
        for (const p of Object.keys(SOURCES)) {
          const r = await tryLoad(p);
          if (r.text.includes(`id: "${effect.id}"`)) {
            if (alive) setSource(r);
            return;
          }
        }
        if (alive) setSourceErr(`没找到 ${effect.id} 的组件源码`);
      } catch (e) {
        if (alive) setSourceErr(`源码加载失败:${e}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [showSource, effect]);

  const apply = () => {
    let o: any;
    try {
      o = JSON.parse(draft);
    } catch (e) {
      setError(`JSON 不合法:${String(e).replace(/^SyntaxError: /, "")}`);
      return;
    }
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      setError("最外层要是一个对象 { ... }");
      return;
    }
    if (o.params !== undefined && (typeof o.params !== "object" || o.params === null || Array.isArray(o.params))) {
      setError("params 要是一个对象");
      return;
    }
    const notes: string[] = [];
    if (card) {
      // 只读字段:改了不生效,当场说清楚
      if (o.id !== undefined && o.id !== card.id) notes.push("id 改不了(已忽略)");
      if (JSON.stringify(o.seg) !== JSON.stringify(card.seg)) notes.push("seg 这里改不了(已忽略,去时间轴拖)");
      if (JSON.stringify(o.lintOff) !== JSON.stringify(card.lintOff)) notes.push("lintOff 请在体检浮窗里点忽略(已忽略)");
      // 时间
      const s = o.start ?? card.start;
      const en = o.end ?? card.end;
      if (typeof s !== "number" || typeof en !== "number" || !(en > s)) {
        setError(`start / end 要是数字且 end > start(现在 start=${s} end=${en})`);
        return;
      }
      // 轨道
      if (o.track !== undefined) {
        const tk = Number(o.track);
        if (!Number.isInteger(tk) || tk < 1) {
          setError("track 要是 ≥ 1 的整数");
          return;
        }
        if (trackCount && tk > trackCount) {
          setError(`track 最多到 ${trackLabel(trackCount)}(先在时间轴加轨道)`);
          return;
        }
      }
      // 特效种类
      if (o.kind !== undefined && o.kind !== card.kind) {
        if (!onKindChange) {
          setError("这里换不了 kind");
          return;
        }
        onKindChange(String(o.kind));
        notes.push(`kind 已换成 ${o.kind}`);
      }
      if (s !== card.start && onTimeChange) onTimeChange("start", s);
      if (en !== card.end && onTimeChange) onTimeChange("end", en);
      if (o.track !== undefined && Number(o.track) !== (card.track ?? 1) && onTrack) onTrack(Number(o.track));
    } else if (o.kind !== undefined && o.kind !== effect.id) {
      notes.push("效果模板页改 kind 不生效,请到效果库点选(已忽略)");
    }
    // 参数:JSON 里有的按新值写;JSON 里删掉的键回到默认值 —— 「删掉一行」才有意义
    if (o.params !== undefined) {
      const next: Record<string, unknown> = { ...o.params };
      for (const k of Object.keys(params ?? {})) {
        if (!(k in next)) next[k] = (effect.defaults as any)?.[k];
      }
      if (onChangeMany) onChangeMany(next);
      else for (const [k, v] of Object.entries(next)) onChange(k, v);
    }
    setError(null);
    setNotice(notes.length ? notes.join(";") : "已应用");
    window.setTimeout(() => setNotice(null), 2400);
  };

  const revert = () => {
    setDraft(current);
    setError(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用(权限/非安全上下文),按钮不响应就好 */
    }
  };

  return (
    <div className="ppc">
      <div className="ppc-bar">
        <span className="ppc-title">{card ? `${card.id} · JSON` : `${effect.id} · 模板 JSON`}</span>
        <span className="ppc-actions">
          <button className="ppc-btn" onClick={copy} title="复制这段 JSON">
            {copied ? "✓ 已复制" : "复制"}
          </button>
          <button className="ppc-btn" onClick={revert} disabled={!dirty} title="放弃修改,回到当前值">
            还原
          </button>
          <button className="ppc-btn ppc-btn--primary" onClick={apply} disabled={!dirty} title="应用(⌘/Ctrl + Enter)">
            应用
          </button>
        </span>
      </div>
      <textarea
        className={`ppc-editor ${error ? "is-err" : ""}`}
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            apply();
          }
          // Tab 打两个空格,别跳焦点
          if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            const a = el.selectionStart;
            const b = el.selectionEnd;
            const v = el.value.slice(0, a) + "  " + el.value.slice(b);
            setDraft(v);
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = a + 2;
            });
          }
        }}
      />
      <div className={`ppc-status ${error ? "is-err" : notice ? "is-ok" : ""}`}>
        {error ?? notice ?? (dirty ? "有未应用的修改 · ⌘/Ctrl + Enter 应用" : "可改:kind / start / end / track / params;删掉某个参数行 = 回到默认值")}
      </div>

      <div className="ppc-src">
        <button className="ppc-src-toggle" onClick={() => setShowSource((v) => !v)}>
          {showSource ? "▾" : "▸"} 组件源码 · {effect.name}.tsx <em>只读</em>
        </button>
        {showSource && (
          <div className="ppc-src-body">
            {source ? (
              <>
                <div className="ppc-src-file">{source.file}</div>
                <pre className="ppc-src-pre">{source.text}</pre>
              </>
            ) : (
              <div className="ppc-src-file">{sourceErr ?? "加载中…"}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
