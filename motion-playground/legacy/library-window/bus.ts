/**
 * 编辑台 ↔ 素材库 的跨窗口消息。
 *
 * 首选 BroadcastChannel(同源的两个窗口 / 标签页之间直达,桌面壳里两个 Tauri 窗口共用一个
 * WebView2 用户数据目录,同样是同源通道);没有它的环境退回 localStorage 的 storage 事件
 * (写一个带时间戳的键,别的窗口会收到 storage 事件)。
 * 同一个页面内(single 模式的浮层)不需要走这里,直接用 props 回调。
 */
import type { SrtLine } from "../overlay/srt";

export type BusMessage =
  /** 素材库 → 编辑台:把这张卡插到当前时刻;track 不传 = 编辑台当前看的那条轨道 */
  | { type: "add-card"; kind: string; params: Record<string, unknown>; track?: number }
  /** 素材库 → 编辑台:设为口播视频(doc.cam) */
  | { type: "set-cam"; src: string }
  /** 素材库 → 编辑台:设为画布参考视频 */
  | { type: "set-video"; src: string }
  /** 素材库 → 编辑台:把这份字幕用作本期字幕稿(编辑台照「导入 SRT」的老逻辑处理,含自动生成字幕层卡) */
  | { type: "set-srt"; name: string; lines: SrtLine[] }
  /** 素材库 → 编辑台:播放头跳到 t 秒(点了字幕里的某一句) */
  | { type: "seek"; t: number }
  /** 任一方:素材登记表(视频 / 字幕)变了,重新读 listVideoAssets() / listSrtAssets() */
  | { type: "assets-changed" }
  /** 编辑台 → 素材库:编辑台当前状态(变化时广播;收到 hello 时也回一份) */
  | {
      type: "editor-state";
      trackCount: number;
      activeTrack: number;
      curT: number;
      trackNames?: Record<number, string>;
      /** 时间轴上所有卡的 [start, end],给字幕列表画「这句已有卡覆盖」的圆点 */
      cardSpans?: [number, number][];
      /** 编辑台当前在用的字幕稿名字(素材库据此标「使用中」);没有 = 未导入 */
      srtName?: string;
    }
  /** 上线打招呼:素材库开窗后发 hello,编辑台回 hello-ack(顺带发一份 editor-state) */
  | { type: "hello"; from: "editor" | "library" }
  | { type: "hello-ack"; from: "editor" | "library" };

const CHANNEL = "overlay-studio";
const LS_KEY = "overlayStudioBus";

type Handler = (msg: BusMessage) => void;
const handlers = new Set<Handler>();
let channel: BroadcastChannel | null = null;
let listening = false;

function ensureListening() {
  if (listening) return;
  listening = true;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (ev) => dispatch(ev.data);
  } else {
    window.addEventListener("storage", (ev) => {
      if (ev.key !== LS_KEY || !ev.newValue) return;
      try {
        dispatch(JSON.parse(ev.newValue).msg);
      } catch {
        /* 坏消息忽略 */
      }
    });
  }
}

function dispatch(msg: unknown) {
  if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return;
  for (const h of handlers) {
    try {
      h(msg as BusMessage);
    } catch (e) {
      console.error("[bus] handler threw", e);
    }
  }
}

/** 发一条消息给别的窗口(自己不会收到) */
export function busSend(msg: BusMessage): void {
  ensureListening();
  if (channel) {
    channel.postMessage(msg);
    return;
  }
  try {
    // storage 事件只在值变化时触发,带上时间戳和随机数保证每次都不一样
    localStorage.setItem(LS_KEY, JSON.stringify({ msg, at: Date.now(), n: Math.random() }));
  } catch {
    /* 存储不可用就当发不出去 */
  }
}

/** 订阅别的窗口发来的消息;返回取消订阅函数 */
export function busSubscribe(handler: Handler): () => void {
  ensureListening();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
