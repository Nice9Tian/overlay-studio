/**
 * 素材库的打开方式。
 *
 * - `single`(singlepage):网页版默认。素材库作为编辑台里的全屏浮层渲染,和编辑台共享同一份 React 状态。
 * - `multi`(multipage):桌面壳(Tauri)默认。用 window.open 开第二个窗口(桌面壳把它变成一个 Tauri 窗口),
 *   两个窗口靠 BroadcastChannel 通信(见 bus.ts)。
 *
 * 桌面壳通过 initialization_script 注入 `window.__OVERLAY_DESKTOP__ = true`;
 * 调试时 URL 加 `?libmode=single` 或 `?libmode=multi` 可强制覆盖。
 */
export type LibraryMode = "single" | "multi";

declare global {
  interface Window {
    __OVERLAY_DESKTOP__?: boolean;
  }
}

const WINDOW_NAME = "overlay-library";

export function libraryMode(): LibraryMode {
  const forced = new URLSearchParams(location.search).get("libmode");
  if (forced === "single" || forced === "multi") return forced;
  return window.__OVERLAY_DESKTOP__ === true ? "multi" : "single";
}

/** 当前页面是不是独立的素材库窗口(?library=1) */
export function isLibraryPage(): boolean {
  return new URLSearchParams(location.search).get("library") === "1";
}

/** 素材库独立窗口的地址:带上当前的 libmode 覆盖(调试时两边保持一致) */
export function libraryPageUrl(): string {
  const u = new URL(location.href);
  u.search = "";
  u.searchParams.set("library", "1");
  const forced = new URLSearchParams(location.search).get("libmode");
  if (forced) u.searchParams.set("libmode", forced);
  return u.toString();
}

let libWin: Window | null = null;

/**
 * 打开素材库。
 * multi 模式:window.open 一个命名窗口(已开着就只聚焦),返回 true;
 * single 模式:什么都不做,返回 false —— 调用方自己渲染 <LibraryWindow embedded />。
 * 桌面壳里 window.open 会被 Rust 的 on_new_window 接管成 Tauri 窗口,返回值可能是 null,这里不依赖它。
 */
export function openLibraryWindow(): boolean {
  if (libraryMode() !== "multi") return false;
  if (libWin && !libWin.closed) {
    try {
      libWin.focus();
      return true;
    } catch {
      /* 跨窗口 focus 被拦也没关系,下面重开 */
    }
  }
  libWin = window.open(libraryPageUrl(), WINDOW_NAME, "width=1280,height=800");
  return true;
}
