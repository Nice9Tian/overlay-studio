import { EFFECTS } from "../effects/registry";
import type { OverlayCard } from "./types";

/**
 * 时间轴色块和左栏列表上显示的两段文字:
 *   加粗的「效果名」(ChapterBar / QuoteLockup …)+ 不加粗的「内容摘要」(这张卡里最主要的那段文案)。
 * 摘要只取一行,超长交给 CSS 的 text-overflow: ellipsis 截,这里不截。
 */

/**
 * 轨道在界面上的叫法:「序列1」「序列2」…(用户要求把 V1/V2 换成中文)。
 * 时间轴标签、参数面板下拉、「加到 …」按钮、左栏缩写都从这里取,别各写各的。
 */
export function trackLabel(n: number, names?: Record<number, string>): string {
  const custom = names?.[n];
  return custom && custom.trim() ? custom : `序列${n}`;
}

/** 效果显示名:registry 里的 name;认不出的 kind 原样返回 */
export function effectName(kind: string): string {
  return EFFECTS.find((e) => e.id === kind)?.name ?? kind;
}

/** 摘要优先看这些参数名(按顺序取第一个非空字符串);都没有再按控件顺序找 text/textarea */
const SUMMARY_KEYS = [
  "text",
  "title",
  "quote",
  "label",
  "name",
  "term",
  "caption",
  "subtitle",
  "headline",
  "chapters",
  "items",
  "lines",
  "content",
  "value",
];

function clean(s: string): string {
  // 卡片文案里的 | 是换行/分段标记,展示成一行时换成 · ;多余空白折叠
  return s.replace(/\|/g, " · ").replace(/\s+/g, " ").trim();
}

/** 卡片内容摘要(单行);没有任何文案时返回空串 */
export function cardSummary(card: Pick<OverlayCard, "kind" | "params">): string {
  const params = card.params ?? {};
  for (const k of SUMMARY_KEYS) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return clean(v);
  }
  const def = EFFECTS.find((e) => e.id === card.kind);
  for (const c of def?.controls ?? []) {
    if (c.type !== "text" && c.type !== "textarea") continue;
    const v = params[c.key];
    if (typeof v === "string" && v.trim()) return clean(v);
  }
  return "";
}
