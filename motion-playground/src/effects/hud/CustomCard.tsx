import type { EffectDef, EffectProps } from "../types";
import { useEnter } from "../useAnimation";
import { useEffect, useRef } from "react";
import {
  ACCENT_OPTIONS,
  ACCENT_VAR,
  OFFSET_CONTROLS,
  OFFSET_DEFAULTS,
  offsetVars,
  THEME_OPTIONS,
} from "./accent";
import { replacePlaceholders, sanitizeCss, sanitizeHtml } from "./customCardSanitize";

export interface CustomCardParams {
  theme: "dark" | "light";
  position: "bottom" | "top-left" | "top-right" | "left" | "right" | "top" | "center";
  title: string;
  body: string;
  html: string;
  css: string;
  enter: "fade" | "rise" | "pop" | "none";
  accent: string;
  offsetX?: number;
  offsetY?: number;
}

function CustomCard({ params, playToken }: EffectProps<CustomCardParams>) {
  const { theme, position, title, body, html, css, enter, accent } = params;
  void theme;
  const entered = useEnter(playToken);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      if (!containerRef.current.shadowRoot) {
        containerRef.current.attachShadow({ mode: "open" });
      }
      const shadow = containerRef.current.shadowRoot!;
      const cleanCss = sanitizeCss(css);
      
      let rawHtml = html.trim();
      if (!rawHtml) {
        rawHtml = `<div><h2>{{title}}</h2><p>{{body}}</p></div>`;
      }
      
      const replacedHtml = replacePlaceholders(rawHtml, title, body, accent);
      const cleanHtml = sanitizeHtml(replacedHtml);
      
      shadow.innerHTML = `<style>:host{display:block}${cleanCss}</style>${cleanHtml}`;
    }
  }, [params, playToken, title, body, html, css, accent]);

  return (
    <div
      className={`hud cc hud-anchor hud-anchor--${position} ${entered ? "is-in" : ""} cc-enter-${enter}`}
      style={{ ["--hud-acc" as string]: ACCENT_VAR[accent] || accent, ...offsetVars(params) }}
    >
      <div ref={containerRef} />
    </div>
  );
}

export const customCardDef: EffectDef<CustomCardParams> = {
  id: "custom-card",
  name: "CustomCard",
  description: "自定义卡",
  selfPosition: true,
  defaults: {
    theme: "dark",
    position: "bottom",
    title: "自定义卡",
    body: "用 HTML + CSS 写你想要的样子",
    html: "",
    css: "",
    enter: "rise",
    accent: "blue",
    ...OFFSET_DEFAULTS,
  },
  controls: [
    { key: "theme", label: "底色(此卡独立生效)", type: "select", options: THEME_OPTIONS },
    {
      key: "position",
      label: "落位",
      type: "select",
      options: [
        { label: "底部居中", value: "bottom" },
        { label: "左上", value: "top-left" },
        { label: "右上", value: "top-right" },
        { label: "左侧", value: "left" },
        { label: "右侧", value: "right" },
        { label: "顶部", value: "top" },
        { label: "居中", value: "center" },
      ],
    },
    { key: "title", label: "卡片标题", type: "text" },
    { key: "body", label: "卡片正文", type: "textarea" },
    {
      key: "html",
      label: "HTML 结构",
      type: "textarea",
      help: "可用标签: div span p b i em strong u s small sup sub br hr h1 h2 h3 h4 ul ol li blockquote code pre img svg path circle rect line g text\n占位符: {{title}} {{body}} {{accent}}\nShadow DOM 隔离，直接写标签即可。",
    },
    {
      key: "css",
      label: "CSS 样式",
      type: "textarea",
      help: "可用变量: var(--hud-acc) (强调色), var(--hud-ink) (主文字), var(--hud-muted), var(--hud-faint) 等。仅对本卡生效。",
    },
    {
      key: "enter",
      label: "进场动画",
      type: "select",
      options: [
        { label: "淡入", value: "fade" },
        { label: "升起", value: "rise" },
        { label: "弹出", value: "pop" },
        { label: "无", value: "none" },
      ],
    },
    { key: "accent", label: "强调色", type: "select", options: ACCENT_OPTIONS },
    ...OFFSET_CONTROLS,
  ],
  Component: CustomCard,
};
