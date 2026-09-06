import { uploadErrText } from "../uploadErr";
import { parseSrt, type SrtLine } from "../overlay/srt";

/* ---------------- 变更通知 ----------------
 * 素材库和编辑台现在同住一个页面,登记表变了直接页内回调就够(不再走 BroadcastChannel)。
 * 另外听一下 storage 事件:别的标签页改了登记表,这边也跟着刷新。
 */
const listeners = new Set<() => void>();

/** 登记表(视频 / 字幕)变了就回调;返回取消订阅函数 */
export function subscribeAssets(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notifyAssets() {
  // 拷贝一份再遍历:回调里退订不会漏掉后面的人
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* 某个订阅者炸了不连累别人 */
    }
  }
}

/**
 * 视频素材登记表。
 *
 * 只是一份「这台机器上导入过哪些视频」的名单,存在 localStorage(overlayStudioAssets),
 * 和编排文件无关 —— 编排里只记最终选用的那条(doc.cam / 画布参考视频)。
 * 文件本体走现有的 /api/media 落盘到 public/_media/,和编辑台「导入视频」是同一条路,
 * 所以导出的无头浏览器同样读得到。删登记不删文件。
 */
export interface VideoAsset {
  id: string;
  name: string;
  /** 站内路径,如 /_media/xxx.mp4?v=…;直接能当 <video src> 和 doc.cam 用 */
  src: string;
  addedAt: string;
  sizeBytes?: number;
  durationSec?: number;
}

const KEY = "overlayStudioAssets";

function read(): VideoAsset[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v?.videos) ? (v.videos as VideoAsset[]) : [];
  } catch {
    return [];
  }
}

function write(videos: VideoAsset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ videos }));
  } catch {
    /* 存储不可用就只留在内存里这一次 */
  }
  notifyAssets();
}

export function listVideoAssets(): VideoAsset[] {
  return read();
}

/** 登记一条视频;同 src(忽略 ?v= 版本号)视为同一条,只更新名字和信息 */
export function addVideoAsset(a: Omit<VideoAsset, "id" | "addedAt">): VideoAsset {
  const list = read();
  const key = a.src.split("?")[0];
  const existing = list.find((x) => x.src.split("?")[0] === key);
  if (existing) {
    Object.assign(existing, a);
    write(list);
    return existing;
  }
  const asset: VideoAsset = {
    id: `va-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    addedAt: new Date().toISOString(),
    ...a,
  };
  list.unshift(asset);
  write(list);
  return asset;
}

export function removeVideoAsset(id: string): void {
  write(read().filter((x) => x.id !== id));
}

/** 读一下视频时长(秒),读不到返回 undefined,不阻塞登记 */
function probeDuration(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (d?: number) => {
      v.removeAttribute("src");
      resolve(d);
    };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : undefined);
    v.onerror = () => done(undefined);
    v.src = src;
    setTimeout(() => done(undefined), 5000);
  });
}

/**
 * 上传一个视频文件(落盘到 public/_media)并登记。
 * 失败抛 Error,消息是人话(和编辑台导入视频的提示口径一致)。
 */
export async function importVideoFile(file: File): Promise<VideoAsset> {
  let r: Response;
  try {
    r = await fetch("/api/media", {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(file.name) },
      body: file,
    });
  } catch (e) {
    throw new Error(`视频落盘失败:${uploadErrText(e)}`);
  }
  const d = await r.json().catch(() => null);
  if (!d?.ok || !d.url) throw new Error(`视频落盘失败:${d?.error ?? `HTTP ${r.status}`}`);
  const durationSec = await probeDuration(d.url);
  return addVideoAsset({ name: file.name, src: d.url, sizeBytes: file.size, durationSec });
}

/* ---------------- 字幕素材(SRT) ----------------
 * 字幕稿以前只住在编辑台左栏(导入一次、自动存档)。搬进素材库后可以登记多份,
 * 选一份「用作本期字幕稿」发给编辑台。字幕文本不大,整份 lines 直接存 localStorage。
 */
export interface SrtAsset {
  id: string;
  name: string;
  lines: SrtLine[];
  addedAt: string;
}

const SRT_KEY = "overlayStudioSrtAssets";

function readSrt(): SrtAsset[] {
  try {
    const raw = localStorage.getItem(SRT_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v?.srts) ? (v.srts as SrtAsset[]) : [];
  } catch {
    return [];
  }
}

function writeSrt(srts: SrtAsset[]) {
  try {
    localStorage.setItem(SRT_KEY, JSON.stringify({ srts }));
  } catch {
    /* 存储不可用就只留在内存里这一次 */
  }
  notifyAssets();
}

export function listSrtAssets(): SrtAsset[] {
  return readSrt();
}

/** 登记一份字幕;同名视为同一份,内容覆盖 */
export function addSrtAsset(a: { name: string; lines: SrtLine[] }): SrtAsset {
  const list = readSrt();
  const existing = list.find((x) => x.name === a.name);
  if (existing) {
    existing.lines = a.lines;
    writeSrt(list);
    return existing;
  }
  const asset: SrtAsset = {
    id: `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    addedAt: new Date().toISOString(),
    ...a,
  };
  list.unshift(asset);
  writeSrt(list);
  return asset;
}

export function removeSrtAsset(id: string): void {
  writeSrt(readSrt().filter((x) => x.id !== id));
}

/** 读一个 .srt 文件并登记;解析不出任何字幕条时抛 Error(人话) */
export async function importSrtFile(file: File): Promise<SrtAsset> {
  const lines = parseSrt(await file.text());
  if (!lines.length) throw new Error("SRT 解析失败:没读到任何字幕条。");
  return addSrtAsset({ name: file.name, lines });
}

/** 字幕总时长(秒):最后一条的结束时间 */
export function srtDuration(lines: SrtLine[]): number {
  return lines.length ? Math.max(...lines.map((l) => l.end)) : 0;
}

/* 别的标签页(或另一个窗口)改了登记表:localStorage 的 storage 事件只发给「其它」页面,
 * 本页自己的改动由 write / writeSrt 里的 notifyAssets 负责。 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    // e.key 为 null = 整个 localStorage 被清空,也当变更处理
    if (e.key === null || e.key === KEY || e.key === SRT_KEY) notifyAssets();
  });
}
