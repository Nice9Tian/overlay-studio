#!/usr/bin/env node
/**
 * 导出透明动效层 · PNG 序列
 * 原理:无头 Chrome + CDP 虚拟时间(Emulation.setVirtualTimePolicy),
 * 时钟完全由脚本控制,每帧精确推进 1000/fps 毫秒再截图(omitBackground → 透明)。
 * 用法: node scripts/export-frames.mjs <job.json>
  * job: { mode: "timeline", doc, fps, duration, base, staticDir, workers }
 *
 * staticDir(或环境变量 OVERLAY_EXPORT_STATIC_DIR):vite build 出来的 dist 绝对路径。
 *   设了就走「静态模式」—— 页面从磁盘直供,Chrome 不再需要连任何端口(见文件中段 F 节实现)。
 * workers(或环境变量 OVERLAY_EXPORT_WORKERS):"auto" 或正整数,默认 auto。
 *   >1 时多开几个浏览器分段渲染(见 G 节实现)。workers=1 且没有 staticDir = 老行为,一字不差。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// 产物根目录可被环境变量搬走(桌面端用); 没设就是原来的 exports/
const EXPORT_ROOT = process.env.OVERLAY_EXPORT_DIR ? path.resolve(process.env.OVERLAY_EXPORT_DIR) : path.join(ROOT, "exports");

const jobFile = process.argv[2];
if (!jobFile) {
  console.error("usage: node export-frames.mjs <job.json>");
  process.exit(1);
}
const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
const {
  mode = "timeline",
  doc = null, // timeline 模式:整份 overlay JSON
  scale = 1,
  speed = 1, // 动画速度倍率(与 Studio「动画速度」滑杆一致)
  fps = 30,
  duration = 6,
  base = "http://localhost:5177",
  keepFrames = false, // true = 保留 PNG 中间目录(verify-effect 逐帧比对要用)
  staticDir = null, // 静态模式:dist 绝对路径;不设 = 老的服务器模式
  workers = null, // 并行度:"auto" 或正整数;不设 = 看环境变量,再不设 = auto
} = job;

const STAGE = { w: 1920, h: 1080 };

// ---- 静态模式开关(F 节)----
// job 优先,其次环境变量(桌面壳走环境变量,命令行用户两个都不设 = 老行为)。
const STATIC_DIR = staticDir
  ? path.resolve(staticDir)
  : process.env.OVERLAY_EXPORT_STATIC_DIR
    ? path.resolve(process.env.OVERLAY_EXPORT_STATIC_DIR)
    : null;

// ---- 并行度开关(G 节)----
// 解析成 "auto" 或 >=1 的整数。写坏了(空串、负数、abc)一律当 auto,
// 不为了一个选项把导出卡死在参数校验上。
const WORKERS_OPT = (() => {
  const raw = workers ?? process.env.OVERLAY_EXPORT_WORKERS ?? "auto";
  if (typeof raw === "string" && raw.trim().toLowerCase() === "auto") return "auto";
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : "auto";
})();

// 静态目录写错了要当场说清楚:等到 Chrome 起来才 404,日志里只剩一句「页面未就绪」,查不出来
if (STATIC_DIR && !fs.existsSync(path.join(STATIC_DIR, "index.html"))) {
  console.error(
    `\n【导出失败原因】静态模式指定的目录里没有 index.html:${STATIC_DIR}\n` +
      `先在 motion-playground 里跑一次 npx vite build,再把 dist 的绝对路径填进来。`,
  );
  process.exit(1);
}

// NTSC 29.97 的真身是 30000/1001(=29.970029970…),写成小数会有微小误差:
// 帧号/时钟用精确值算,传给 ffmpeg 的帧率用分数字符串,避免它按 2997/100 编码
const isNTSC = Math.abs(fps - 29.97) < 0.01;
const FPS = isNTSC ? 30000 / 1001 : fps;
const FPS_ARG = isNTSC ? "30000/1001" : String(fps);

const totalFrames = Math.max(1, Math.round(duration * FPS));
const intervalMs = 1000 / FPS;

// 开工前先看磁盘够不够:PNG 序列约 14MB/s、ProRes 4444 约 29MB/s,再留 2GB 余量。
// 中途写满会得到一个"没有 moov 索引"的半截 MOV —— 剪映只会说"文件损坏",查不出原因。
// fs.statfsSync 三平台通用(旧实现用 df,Windows 上没这命令,静默返回 Infinity
// 等于保护失效)。查不到就放行,不为了一个预检卡住导出。
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}
const needBytes = duration * (14 + 29) * 1024 * 1024 + 2 * 1024 ** 3;
const gb = (n) => (n / 1024 ** 3).toFixed(1);

// 工作目录 exports/<名称>-<时间戳>/(PNG 序列等中间产物)
// 成品目录 exports/output/(给剪映用的 MOV/WebM 全部只放这里)
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const name = "timeline";
const outDir = path.join(EXPORT_ROOT, `${name}-${stamp}`);
const finalDir = path.join(EXPORT_ROOT, "output");


// ---- 卡内视频预抽帧 ----
// 虚拟时钟下 Chrome 媒体管线完全冻结:<video> 的加载和 seek 永远不完成,
// 每帧干等超时(导出极慢)且画面为空。先用 ffmpeg 把用到的视频按导出帧率
// 抽成 JPEG 序列放进 public/_fxframes/,页面在导出模式用 <img> 逐帧换图。
const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

function collectVideoUses() {
  // { src → 需要抽的秒数 }:camSrc 从时间轴 0 起播,要抽到卡片结束的绝对秒;
  // 其余(videoSrc/src/img 槽)从卡片 start 起算,抽卡片时长即可
  const need = new Map();
  const add = (src, sec) => {
    if (typeof src === "string" && VIDEO_RE.test(src))
      need.set(src, Math.max(need.get(src) ?? 0, sec));
  };
  // 片段偏移:填了「从第几秒开始播」的槽,需要的是 clip → clip+窗口 这一段。
  // 只抽前 win 秒的话,clip=24 的素材导出时那一段根本没有帧(画面会是空的)
  const clipKeyOf = (k) => {
    if (/^videoSrc$/.test(k)) return "clipStart";
    const v = k.match(/^videoSrc(\d+)$/);
    if (v) return `clipStart${v[1]}`;
    const i = k.match(/^img(\d+)$/);
    if (i) return `clip${i[1]}`;
    return "clipStart";
  };
  if (mode === "timeline" && doc?.cards) {
    for (const c of doc.cards) {
      const win = Math.max(0, (c.end ?? 0) - (c.start ?? 0));
      // 倍速播放会吃掉更多素材:窗口 8s、2 倍速 → 要抽到素材的第 16 秒
      const rate = Math.max(0.1, Number(c.params?.vidRate) || 1);
      for (const [k, v] of Object.entries(c.params ?? {})) {
        const clip = Math.max(0, Number(c.params?.[clipKeyOf(k)]) || 0);
        add(v, k === "camSrc" ? (c.end ?? duration) : clip + win * rate);
      }
    }
    if (doc?.cam) add(doc.cam, duration);
  }
  return need;
}

const cacheRoot = path.join(ROOT, "public", "_fxframes");

function extractVideoFrames(need = collectVideoUses()) {
  const manifest = {};
  if (!need.size) return manifest;
  // 抽帧要 ffmpeg 和 ffprobe 两个命令,**分别探**。
  // 以前只探 ffmpeg:装法不同的机器(Windows 上分开装、或只装了其中一个)ffprobe 会缺,
  // 于是每张卡都走到下面「读不到时长」那条 continue,导出照跑,成片里视频窗全是空的
  // —— 而且没有任何一句是红色的,客户拿到坏成片多半不会来问,只会觉得这软件不行。
  //
  // 编排里根本没有视频卡时这段不会执行(上面 need.size 为 0 就返回了),
  // 所以纯图文的片子不装 ffmpeg 照样导得出来,这里不会误伤。
  for (const [bin, what] of [["ffmpeg", "抽帧"], ["ffprobe", "读视频时长"]]) {
    if (spawnSync(bin, ["-version"], { stdio: "ignore" }).status !== 0) {
      console.error(
        `\n【导出失败原因】这条编排里有卡要放视频,需要 ${bin}(用来${what}),但本机没装或不在 PATH 里。\n` +
          `装好之后重新导出即可:\n` +
          `  macOS:   brew install ffmpeg\n` +
          `  Windows: winget install --id Gyan.FFmpeg -e\n` +
          `(ffmpeg 和 ffprobe 通常一起装上;只装了一个的话把另一个补齐。装完要重开终端。)`,
      );
      process.exit(1);
    }
  }
  // 清理 7 天前的旧缓存
  if (fs.existsSync(cacheRoot)) {
    for (const d of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, d);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5)
        fs.rmSync(p, { recursive: true, force: true });
    }
  }
  for (const [src, needSec] of need) {
    const rel = decodeURIComponent(src.split("?")[0]);
    const file = path.join(ROOT, "public", rel.replace(/^\//, ""));
    if (!fs.existsSync(file)) {
      console.log(`vid-frames: 找不到 ${rel},该视频窗将为空`);
      continue;
    }
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file],
      { encoding: "utf8" },
    );
    const dur = parseFloat(probe.stdout) || 0;
    if (!dur) {
      console.log(`vid-frames: 读不到时长 ${rel},该视频窗将为空`);
      continue;
    }
    const useSec = Math.min(dur, needSec + 0.5);
    const mtime = Math.floor(fs.statSync(file).mtimeMs / 1000);
    const key = `${path.basename(file).replace(/[^\w.-]+/g, "_")}-${fps}fps-${mtime}-${Math.ceil(useSec)}s`;
    const dir = path.join(cacheRoot, key);
    const manifestFile = path.join(dir, "manifest.json");
    let count = 0;
    if (fs.existsSync(manifestFile)) {
      count = JSON.parse(fs.readFileSync(manifestFile, "utf8")).count; // 命中缓存,免重抽
    } else {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`extracting video frames: ${rel} (${useSec.toFixed(1)}s @ ${fps}fps)...`);
      const r = spawnSync(
        "ffmpeg",
        ["-y", "-i", file, "-t", String(useSec), "-vf", `fps=${FPS_ARG}`, "-q:v", "4",
          path.join(dir, "f_%05d.jpg")],
        { stdio: "ignore" },
      );
      count = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length
        : 0;
      if (r.status !== 0 || !count) {
        console.log(`vid-frames: 抽帧失败 ${rel},该视频窗将为空`);
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      fs.writeFileSync(manifestFile, JSON.stringify({ count, fps: FPS, dur }));
    }
    manifest[src] = { dir: `/_fxframes/${key}`, fps: FPS, count, dur };
  }
  return manifest;
}

// ---- 磁盘预检:放在抽帧清单算出来之后 ----
// 以前只算 PNG 序列 + ProRes 成片,**卡内视频抽的 JPEG 不在账里** —— 全局口播是按整条时长抽的,
// 20 分钟的口播在 30fps 下就是三万多张 JPEG(几个 GB),预检说「够」,抽到一半盘满了。
// 按每帧 200KB 估(1080p、-q:v 4 的实测量级),宁可高估。
const videoUses = collectVideoUses();
const frameBytes = [...videoUses.values()].reduce((a, sec) => a + sec * FPS * 200 * 1024, 0);
const needTotal = needBytes + frameBytes;
// 必须先 mkdir 再查: 目录不存在时 statfsSync 会抛异常, 被 catch 吞掉退回 Infinity, 预检就白做了
fs.mkdirSync(EXPORT_ROOT, { recursive: true });
const freeNow = freeBytes(EXPORT_ROOT);
if (freeNow < needTotal) {
  console.error(
    `\n【导出失败原因】磁盘空间不够:还剩 ${gb(freeNow)}GB,这条 ${Math.round(duration)}s 的片子` +
      `大约需要 ${gb(needTotal)}GB(PNG 序列 + ProRes 成片` +
      (frameBytes ? ` + 卡内视频抽帧 ${gb(frameBytes)}GB` : "") +
      ` + 余量)。\n` +
      `先腾地方再导 —— exports/ 里除 output 外的目录都是 PNG 中间产物,成片出来后可以整个删;` +
      `public/_fxframes/ 是视频抽帧缓存,也可以整个删。`,
  );
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(finalDir, { recursive: true });

const vidFrames = extractVideoFrames(videoUses);

// timeline 的整份编排不放 URL:中文转码后网址会超过服务器 16KB 上限(HTTP 431),
// 改在 page.goto 前用 evaluateOnNewDocument 注入 window.__EXPORT_DOC
//
// 静态模式用一个**不存在的主机名** overlay.local:DNS 解析不了正好,所有请求都被
// 拦截器接管(见 installStaticRoutes)。不用 file:// 是因为 ES module + CORS 在
// file:// 下直接被浏览器拒掉,dist 的 <script type="module"> 根本跑不起来。
const url = STATIC_DIR
  ? `http://overlay.local/index.html?export=1&mode=timeline&fx=${scale}&spd=${speed}`
  : `${base}/?export=1&mode=timeline&fx=${scale}&spd=${speed}`;

// 等「虚拟时钟推进完毕」这个事件,**带超时**。以前是裸等:渲染器假死(没崩、只是不再响应)
// 事件永远不来,这个进程就永远挂着 —— 服务端的导出锁也就永远解不开,用户之后每次点导出
// 都是「已有导出任务在进行中」,只能重启 npm run dev。一帧的虚拟时间几十毫秒就该推完,
// 30 秒没动静一定是出事了,与其干等不如报错退出,让人重来。
function waitBudgetExpired(client, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `渲染器 ${ms / 1000} 秒没有推进(多半是假死了)。重新导出一次;还不行就重启 npm run dev`,
          ),
        ),
      ms,
    );
    client.once("Emulation.virtualTimeBudgetExpired", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const LAUNCH_OPTS = {
  headless: "new",
  // 静态模式让 CDP 走管道(puppeteer 见到 pipe:true 就加 --remote-debugging-pipe):
  // 不开监听端口,并行起 6 个浏览器也不会撞端口,Windows 防火墙也不会弹窗。
  // 服务器模式保持原样(老行为一字不改)。
  ...(STATIC_DIR ? { pipe: true } : {}),
  args: [
    "--force-color-profile=srgb",
    "--disable-background-timer-throttling",
    "--run-all-compositor-stages-before-draw",
    "--disable-lcd-text",
    // Chrome 的新无头模式在 Windows 11 上会把一个 780×580 的空窗口画到桌面左上角
    // (Chrome 129 起的已知问题,puppeteer/selenium 都有人报),导出全程挂在那儿,
    // 看着像程序出了毛病。把窗口挪到屏幕外就看不见了;渲染走的是离屏缓冲,不受影响。
    "--window-position=-32000,-32000",
  ],
};

// ============================================================================
// F. 静态模式:Chrome 不再需要端口
// ----------------------------------------------------------------------------
// 导出页(?export=1 → ExportView)一个 /api/ 都不调,所以 vite build 出来的 dist
// 完全够用。请求全部由 page.setRequestInterception 接管,从磁盘直供:
// 桌面壳导出时不用等 dev server、不占端口、断网也能导。
// ============================================================================

// 扩展名 → Content-Type。猜错会有实实在在的后果:.js 报成 text/plain 时
// <script type="module"> 会被浏览器直接拒绝执行,页面白屏但没有任何报错。
const STATIC_MIME = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain",
};
const mimeOf = (file) =>
  STATIC_MIME[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

/**
 * URL 路径 → 本地文件绝对路径;返回 null = 404。
 *
 * 映射(顺序有讲究):
 *   /、/index.html        → <staticDir>/index.html
 *   /assets/*             → <staticDir>/assets/*      构建产物
 *   /src/assets/fonts/*   → <ROOT>/src/assets/fonts/*  用户后丢进去的字体,构建时可能还没有
 *   其余                  → <ROOT>/public/*,再退回 <staticDir>/*
 *
 * public/ 排在 dist/ 前面:_fxframes(本次导出刚抽的视频帧)、_media(用户新传的素材)
 * 都是**运行期才生成**的,dist 里那份是构建当时的旧快照,先命中它就会拿到过期文件。
 */
function staticFileFor(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null; // %ZZ 之类的坏转义
  }
  p = p.replace(/^\/+/, "");
  if (p === "" || p === "index.html") return path.join(STATIC_DIR, "index.html");
  // 逐段查:`..` 要在 decodeURIComponent **之后**挡,否则 %2e%2e 能绕过去。
  // 空段(//)和 `.` 一起拒掉,省得后面 path.resolve 出意外形状。
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  const cands = p.startsWith("assets/")
    ? [[STATIC_DIR, p]]
    : p.startsWith("src/assets/fonts/")
      ? [[ROOT, p]]
      : [
          [path.join(ROOT, "public"), p],
          [STATIC_DIR, p],
        ];
  for (const [root, rel] of cands) {
    const abs = path.resolve(root, rel);
    // 兜第二层:解析完还得在根目录里面(Windows 上盘符/短名之类的意外形状也一并挡掉)
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch {
      /* 不存在,试下一个候选 */
    }
  }
  return null;
}

/**
 * 静态包里的 @font-face 是**构建期**由 src/fonts.ts 扫出来的,用户构建之后再丢进
 * src/assets/fonts/ 的字体不在里面。这里按同一套命名规则(文件名去扩展名 = 家族名,
 * 结尾 -三位数字 = 字重,没写就是 400)现扫一遍补上。和 bundle 里已有的声明重复无害
 * —— 后声明的同名同字重 @font-face 只是覆盖,不会两份都下载。
 */
function customFontCss() {
  const dir = path.join(ROOT, "src", "assets", "fonts");
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
  } catch {
    return ""; // 目录都没有 = 没自定义字体
  }
  return files
    .map((f) => {
      const stem = f.replace(/\.(ttf|otf|woff2?)$/i, "");
      const m = stem.match(/^(.+)-(\d{3})$/);
      const family = m ? m[1] : stem;
      const weight = m ? m[2] : "400";
      return (
        `@font-face{font-family:"${family}";font-weight:${weight};` +
        `src:url("/src/assets/fonts/${encodeURIComponent(f)}");font-display:swap;}`
      );
    })
    .join("\n");
}

// 外部请求只在第一次打日志:一个页面能有几十条(Google Fonts、埋点、favicon),
// 全打出来会把导出日志冲掉,而用户真正要知道的只是「导出不联网」这一件事。
let externalAbortLogged = false;

/** 装上静态路由。必须在 goto 之前调用。 */
async function installStaticRoutes(page) {
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const done = (fn) => fn.catch(() => {}); // 请求可能已被页面取消,回应失败无所谓
    let u;
    try {
      u = new URL(req.url());
    } catch {
      return done(req.continue());
    }
    // data:/blob: 这类页面自产的 URL 不经过网络,放行就是了
    if (u.protocol !== "http:" && u.protocol !== "https:") return done(req.continue());
    if (u.hostname !== "overlay.local") {
      if (!externalAbortLogged) {
        externalAbortLogged = true;
        console.log(`static: 外部请求已切断(第一条 ${u.origin}${u.pathname}),导出全程不联网`);
      }
      return done(req.abort());
    }
    const file = staticFileFor(u.pathname);
    if (!file) return done(req.respond({ status: 404, contentType: "text/plain", body: "not found" }));
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      return done(req.respond({ status: 404, contentType: "text/plain", body: "not found" }));
    }
    return done(req.respond({ status: 200, contentType: mimeOf(file), body }));
  });
}

// puppeteer 捆绑的 Chromium 没下载时(~/.cache/puppeteer 为空,npm 安装时跳过了
// 下载步骤),launch 会报「must specify executablePath」。
//
// 以前这里退回本机 Google Chrome 继续跑。**改成直接停下**,因为那条退路
// 产出的是坏成片:实测 Chrome 151 在无头+虚拟时间下不推进 CSS 动画时间线,靠
// transition/animation 淡入的卡会整张停在 opacity:0(踩过,字幕和大半动效
// 全不见)。原来只 console.warn 一句 —— 它混在几百行导出日志里,界面上是绿色的
// 「导出完成」,用户拿到一条缺了一半动效的片子,还以为是自己编排没做好。
//
// 一条命令就能装好,报错停下比默默交坏片强得多。
//
// 所有开过的浏览器(并行时不止一个)。finally 里统一收尾:任何一个工作器出事,
// 剩下几个 Chrome 也必须跟着走,不然进程树里会留下一堆没人管的 chrome.exe。
const openedBrowsers = [];
// 渲染循环跑完才置 true:catch 里靠它区分「渲染到一半崩了」(PNG 是半成品,删)
// 和「渲染完了、合成失败」(PNG 是几分钟的成果,留着可手动重合成)。
let framesDone = false;

/**
 * 起浏览器 + 把页面准备到「可以逐帧推进」的状态。
 * 主页面和并行工作器共用同一份准备流程 —— 任何一步的顺序/参数在这里改一下,
 * 两边就一起改,不会出现「主页面注了 __EXPORT_DOC、工作器忘了」这种偏差。
 * 返回的 startCost 是从 launch 到 __startExport 返回的秒数,并行规划要用它
 * 当「每多开一个工作器的固定开销」。
 */
async function openRenderPage({ isMain = false } = {}) {
  const tLaunch = Date.now();
  let browser;
  try {
    browser = await puppeteer.launch(LAUNCH_OPTS);
  } catch (err) {
    if (!/executablePath|Could not find/i.test(String(err?.message))) throw err;
    console.error(
      "\n【导出失败原因】渲染器(Chromium)没装好,导不了。\n" +
        "在项目文件夹里运行这一条,然后重新导出:\n" +
        "  npx puppeteer browsers install chrome\n" +
        "(以前这里会退回用你电脑上的 Chrome 硬跑,但那样导出的片子会缺掉大半动效,\n" +
        " 所以现在宁可停下来告诉你,也不给你一条坏片。)",
    );
    // 主页面起不来就是导不了,行为和改动前一样直接退出;工作器起不来则抛给
    // Promise.all,让外层按「渲染中途失败」清掉半成品 PNG 再退出。
    if (isMain) process.exit(1);
    throw new Error("并行工作器的渲染器(Chromium)起不来");
  }
  openedBrowsers.push(browser);
  const page = await browser.newPage();

  // ⚠️ 钉死 CSS 动画钟校正系数(勿删)。
  // ExportView 会在开跑瞬间实测一个 __fxClockRate,再每帧把所有动画的 playbackRate
  // 乘上它。实测这个值在不同运行里会落在 1~5.5 之间;一旦落到 5 附近,
  // 进场过渡就整个卡死在第一帧 —— 卡片挂上了、is-in 也加了,但内层 opacity 恒为 0,
  // 短卡(<2s)从头到尾看不见,长卡晚好几秒才出现。
  // 这就是"同一份编排、同一份代码,有的导出好有的丢卡"的真正原因(排查见 8/28 记录)。
  // 实测 forced=1 时 126.7s 空镜卡内层 opacity 0→0.92、133s VERDICT 0→0.64,进场恢复正常。
  await page.evaluateOnNewDocument(() => {
    let _r = 1;
    Object.defineProperty(window, "__fxClockRate", {
      get: () => _r,
      set: () => {},           // 屏蔽实测值写入
      configurable: true,
    });
    void _r;
  });
  await page.setViewport({ width: STAGE.w, height: STAGE.h, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();

  // 记录页面里的 JS 报错,失败时给出人话原因
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).split("\n")[0]));

  // 页面底色透明(截图 omitBackground 的前提)
  await client.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  // 整份编排在页面脚本运行前注入(见上面 url 处注释)
  if (mode === "timeline") {
    await page.evaluateOnNewDocument((s) => {
      window.__EXPORT_DOC = s;
    }, JSON.stringify(doc));
  }
  // 视频帧序列清单:页面 __seekVideos 按它逐帧换 img.src
  await page.evaluateOnNewDocument((m) => {
    window.__VID_FRAMES = m;
  }, vidFrames);

  // 静态模式:路由必须在 goto 之前装好,否则第一批请求(index.html、主 chunk)会漏出去
  if (STATIC_DIR) await installStaticRoutes(page);

  // 正常时间加载页面(动效被 __startExport 闸住,不会提前播)
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 }).catch((e) => {
    throw new Error(
      `导出页面加载超时(30s)。常见原因:某张卡引用的录屏/图片文件已被删除,或素材过大。原始错误:${String(e).split("\n")[0]}`,
    );
  });

  // 静态包的 @font-face 是构建时那一份,补上构建之后新增的字体(见 customFontCss)。
  // 位置有讲究:goto 之后(有 document 可插)、fonts.ready 之前(等得到这批字体)。
  if (STATIC_DIR) {
    const css = customFontCss();
    if (css) await page.addStyleTag({ content: css }).catch(() => {});
  }

  // 就绪检测:TimelineExport 挂载后才有 __startExport;
  // 没有 = 编排解析失败(页面上会显示红字原因)或页面 JS 崩溃
  await page
    .waitForFunction("typeof window.__startExport === 'function'", { timeout: 15000 })
    .catch(async () => {
      const hint = await page
        .evaluate(() => (document.body.innerText || "").trim().slice(0, 200))
        .catch(() => "");
      throw new Error(
        `导出页面未就绪:${hint || pageErrors[0] || "页面白屏(JS 报错)"}`,
      );
    });

  // 自定义字体加载完再开闸,避免前几帧渲染成回退字体
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  // 冻结时钟 → 开闸 → 从 t=0 逐帧推进
  await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  await page.evaluate(() => window.__startExport());

  return { browser, page, client, startCost: (Date.now() - tLaunch) / 1000 };
}

/** 浏览器收尾:假死的连 close 都可能不回,给 10 秒就直接杀 */
async function closeBrowser(browser) {
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
  try {
    browser.process()?.kill("SIGKILL");
  } catch {
    /* 已经退出了 */
  }
}

// 进度是**共享**计数器:并行时几个工作器各渲各的段,谁截完一帧谁加一。
// 输出格式 `progress <done>/<total>` 是 vite 中间件解析的契约,不能改。
// 串行(workers=1)时 done 恒等于帧号,和改动前一模一样。
let framesShot = 0;
function bumpProgress() {
  framesShot++;
  if (framesShot % 30 === 0 || framesShot === totalFrames) {
    console.log(`progress ${framesShot}/${totalFrames}`);
  }
}

/**
 * 逐帧推进 [from, to]。
 *
 * shoot=false 是「快进」:每帧状态 = 显式下发的 t + 每个 CSS 动画**累加**的
 * currentTime,所以负责后半段的工作器必须把前面每一帧都照着走一遍。
 *
 * ⚠️ 快进除了「不把 PNG 写到盘上」之外,必须和渲染路径**逐步一致**(勿删)。
 * 曾经为了省时间,快进砍掉了 __seekVideos 和 page.screenshot(),结果是:
 *   1) 少了截图 = 少了一次强制绘制/合成。截图会同步走完 layout→paint→composite,
 *      也就顺带跑掉一批 rAF 回调;不截图时同一段虚拟时间里页面产生的 rAF/paint
 *      次数变了,「快进结束那一刻」的页面状态和串行走到同一帧时**不一样**。
 *      实测(demo 编排、600 帧、静态模式):每个工作器分段起点之后会稳定地出现
 *      约 30 帧连续不一致 —— 块的起点精确等于分段起点,块长恰好等于当时在途的
 *      进场过渡时长(odometer 卡),过渡结束后两边重新收敛。可复现、随分段起点移动,
 *      不是噪声。
 *   2) 少了 __seekVideos = 快进全程 img[data-fx-vidimg] 的 src 一直为空,
 *      布局(以及依赖布局的动效)与串行不同,同样会在边界处出错。
 * 所以这里两条都照做,只把「写 1920×1080 的 PNG」换成一张不落盘的低质 JPEG:
 * 整幅画面照样被强制光栅化(视频帧图也才会真的解码),而 PNG 编码和落盘的开销
 * (c_shot,单帧成本的大头)省掉了。实测这一改把边界块完全消掉,
 * 600 帧 3 工作器整轮从 42.9s(不截图、但结果是错的)升到 55.1s,仍快于串行的 60.1s。
 * 代价是 c_ff 略升,但仍远小于 c_shot,G4 的规划模型不用改。
 *
 * timings 传数组时每帧记一条 { step, shot }:自动缩放靠它测本机的单帧成本。
 */
async function renderFrames(page, client, from, to, { shoot = true, timings = null } = {}) {
  for (let i = from; i <= to; i++) {
    const tA = timings ? Date.now() : 0;
    // 先下发本帧精确时间(卡片挂载/节拍全跟它走)+ 换视频帧图,再推时钟:
    // 推进期间页面完成渲染与绘制,截图即为 t=(i-1)/fps 的画面。
    // 帧覆盖的是 [0, duration) 而不是 (0, duration]:以前从 1/fps 起步,开头丢了
    // t=0 那一帧、结尾多出 t=duration 那一帧 —— 而卡片可见区间是左闭右开
    // (t < end),末帧正好踩在 end 上,于是成片最后一帧是全空的。
    await page
      .evaluate((t) => {
        if (window.__setExportT) window.__setExportT(t);
        if (window.__seekVideos) window.__seekVideos(t);
      }, (i - 1) / fps)
      .catch(() => {});
    // 换 src 后帧图在真实时间里加载(本地静态文件,通常几毫秒):就绪再推帧
    for (let k = 0; k < 20; k++) {
      const pending = await page
        .evaluate(() => (window.__pendingVidFrames ? window.__pendingVidFrames() : 0))
        .catch(() => 0);
      if (!pending) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const p = waitBudgetExpired(client);
    // 先给它挂一个空的 catch。下面那句 client.send 一旦先抛(并行时最常见:另一个
    // 工作器出事、浏览器被收尾关掉,这条连接立刻 "Target closed"),`await p` 就永远
    // 执行不到,30 秒后看门狗的 reject 便成了**悬空拒绝** —— Node 直接以
    // unhandledRejection 崩掉整个进程,把上面刚打好的「导出失败原因」冲成一段
    // 看不懂的 TargetCloseError 堆栈,PNG 清理也做不完。挂了 catch 只是「标记已处理」,
    // 不影响后面 `await p` 照样抛出真正的超时错误。
    p.catch(() => {});
    await client.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget: intervalMs,
    });
    await p;
    // ⚠️ 确定性动画步进(勿删)。CSS 过渡/动画的钟在无头虚拟时间下
    // 快慢不定(实测同一台机器不同一次运行,偏差 1x~5.4x;偏差大时进场过渡
    // 整个卡死在第一帧,短卡全程隐形 —— 就是"同一编排有的导出好有的丢卡"的根源)。
    // 从本版起不再信任任何钟:每推进一帧虚拟时间,就把页面里所有动画显式
    // 暂停并手动 +intervalMs。动画进度与时间轴逐帧锁死,与机器负载无关。
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        try {
          if (a.playState !== "paused") a.pause();
          a.currentTime = Number(a.currentTime ?? 0) + ms;
        } catch { /* 已结束/已移除的动画,跳过 */ }
      }
    }, intervalMs);
    const tB = timings ? Date.now() : 0;
    if (!shoot) {
      // 快进也要截一张:强制一次完整的绘制/合成,让页面状态和串行逐帧对齐(见函数头注释)。
      // 不写 path 就不落盘;省钱靠的是编码器而不是画幅 ——
      // jpeg + quality 0 + optimizeForSpeed 比 PNG 快一个量级(实测整轮只多 2 秒)。
      //
      // ⚠️ 别改成 `clip: {0,0,1,1}`(勿删)。看着更省,实际上 Chrome 只光栅化 clip
      // 覆盖到的那一小块,视口里其余部分**不会真的画**,于是视频帧图那种要解码的内容
      // 在快进期间一直没被解码。后果是带视频卡的编排在工作器的头两帧拿到还没解好的图:
      // 实测(focus-card + camSrc、345 帧、workers=3)clip 版稳定差 3 帧(199、266-267,
      // 266 正是工作器 2 的分段起点),换成整幅 jpeg 后 0 帧不一致,而串行两次本来就是 0 帧。
      await page.screenshot({ omitBackground: true, type: "jpeg", quality: 0, optimizeForSpeed: true });
      continue;
    }
    await page.screenshot({
      path: path.join(outDir, `frame_${String(i).padStart(6, "0")}.png`),
      omitBackground: true,
    });
    if (timings) timings.push({ step: (tB - tA) / 1000, shot: (Date.now() - tB) / 1000 });
    bumpProgress();
  }
}

// 这里以前有个 warmVideoFrames():快进不换帧图,工作器到分段第一帧才第一次冷加载
// 全部视频窗,20×10ms 的等待预算不够,于是先单独热一轮。现在快进每帧都照常
// __seekVideos + 等帧图(见 renderFrames 头上的「逐步一致」),分段第一帧和串行走到
// 同一帧时处境完全相同(上一帧的图已经挂着、只换几张),那一轮预热就成了**多余的一次
// __setExportT 下发** —— 串行路径没有它,留着反而是一处新的不等价。故删。

// ============================================================================
// G. 并行规划
// ----------------------------------------------------------------------------
// 工作器不能凭空跳到第 s 帧:它得从第 1 帧一路快进过去(每帧 c_ff 秒)。
// 所以越靠后的工作器「开工前的沉没成本」越大,分段必须**前长后短**才能同时收工。
// 下面这两个函数就是在解「让所有人同时收工的那条时间线 T 是多少」。
// ============================================================================

/** 给定收工时刻 T,反推每个工作器能吃下多少帧(实数,给二分用) */
function planSegments(N, T, c) {
  const segs = [];
  let sum = 0;
  // 主页面接着探测帧往下渲,不重启、不快进
  segs.push(Math.max(0, T / c.cFrame));
  sum += segs[0];
  for (let i = 1; i < N; i++) {
    const start = c.K + 1 + sum; // s_i:这个工作器的第一帧
    // 起浏览器 c_start + 快进 (s_i-1) 帧 + 正式渲 L_i 帧 = T
    const L = (T - c.cStart - (start - 1) * c.cFF) / c.cFrame;
    segs.push(Math.max(0, L));
    sum += segs[i];
  }
  return { segs, sum };
}

/** 二分出 N 个工作器分掉 R 帧时的收工时刻,并把分段取整(和恰好等于 R) */
function planFor(N, R, c) {
  let lo = 0;
  let hi = c.cStart + (c.K + R) * (c.cFrame + c.cFF) + 10; // 一个稳超的上界
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (planSegments(N, mid, c).sum < R) lo = mid;
    else hi = mid;
  }
  const { segs } = planSegments(N, hi, c);
  const ints = segs.map((x) => Math.max(0, Math.round(x)));
  // 取整的零头全落在主页面那一段上:它没有快进成本,多几帧少几帧最不敏感
  ints[0] += R - ints.reduce((a, b) => a + b, 0);
  return { wall: hi, segs: ints };
}

try {
  const main = await openRenderPage({ isMain: true });
  const { page, client } = main;

  // 逐帧渲染真正开跑的时刻。进度浮窗的「预计还需」要从这里起算 ——
  // 从任务启动起算的话,前面抽帧/启浏览器那几分钟会被摊进「每帧耗时」,
  // 开头能报出好几十分钟然后一路往下掉(客户看到的「50 分钟」就是这么来的)。
  console.log(`rendering frames: ${totalFrames}`);

  if (WORKERS_OPT === 1) {
    // 老路子:一个页面从头跑到尾。这条分支和改动前逐字节等价,不许长东西。
    console.log(`workers: 1`);
    await renderFrames(page, client, 1, totalFrames);
  } else {
    // ---- 环境上限:别把机器榨干(每个 Chrome 渲 1080p 大约吃 600MB) ----
    let envMax = WORKERS_OPT; // 显式指定几个就按几个来,只受下面「分段太碎」的否决
    if (WORKERS_OPT === "auto") {
      const cores = typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;
      const freeMB = os.freemem() / 2 ** 20;
      const maxByCpu = Math.max(1, Math.floor(cores / 4));
      const maxByMem = Math.max(1, Math.floor((freeMB - 1024) / 600));
      envMax = Math.min(6, Math.max(1, Math.min(maxByCpu, maxByMem)));
      console.log(
        `workers: env cores=${cores} freeMB=${Math.round(freeMB)}` +
          ` → maxByCpu=${maxByCpu} maxByMem=${maxByMem} max=${envMax}`,
      );
    }

    // 短片子并行只赔不赚:探测就要 60 帧,起第二个浏览器还要几秒
    if (WORKERS_OPT === "auto" && (totalFrames < 300 || envMax === 1)) {
      console.log(`workers: 1(总帧数 ${totalFrames}、环境上限 ${envMax},不值得并行)`);
      await renderFrames(page, client, 1, totalFrames);
    } else {
      // ---- 探测:主页面照常渲前 K 帧,顺手把单帧成本量出来 ----
      const K = Math.min(60, totalFrames);
      const timings = [];
      await renderFrames(page, client, 1, K, { timings });
      // 前 10 帧要挂载首批卡片、JIT 还没热,慢得不像话,量它们只会低估并行收益
      const tail = timings.length > 10 ? timings.slice(10) : timings;
      const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      // c_ff 量的是「步进」那一段(下发 t + 等帧图 + 推虚拟时间 + 动画步进),
      // 而真正的快进还要多一次 1×1 截图(见 renderFrames 的「逐步一致」)。
      // 所以 c_ff 是**低估**的:实测 demo 编排量出 0.0017s,而快进的实际单帧成本
      // 约 0.019s(拿「旧快进 42.9s / 新快进 55.1s、共 700 个快进帧」倒推)。
      // 低估的后果是规划把靠后的工作器的沉没成本算轻了、给它们分的帧偏多。
      // 没有改成实测:c_ff 仍只有 c_shot(0.048s)的三分之一,分段仍然大致均衡
      // (实测 N=3 时三条线收工时间差在 10% 以内),而要准确测它就得先起一个工作器
      // 空跑几十帧,那笔开销比它能省下的还多。
      const c = {
        K,
        cFF: avg(tail.map((x) => x.step)),
        cShot: avg(tail.map((x) => x.shot)),
        cStart: main.startCost,
      };
      c.cFrame = c.cFF + c.cShot;
      const R = totalFrames - K;
      console.log(
        `workers: probe K=${K} c_ff=${c.cFF.toFixed(4)}s c_shot=${c.cShot.toFixed(4)}s` +
          ` c_frame=${c.cFrame.toFixed(4)}s c_start=${c.cStart.toFixed(2)}s 剩余 ${R} 帧`,
      );

      // ---- 规划:把每个 N 的预测都打出来,选完再说选了哪个 ----
      let chosenN = 1;
      let chosenSegs = [R];
      if (R > 0) {
        let prevWall = planFor(1, R, c).wall;
        console.log(`workers: plan N=1 预计 ${prevWall.toFixed(1)}s 分段 ${R}`);
        for (let N = 2; N <= envMax; N++) {
          const p = planFor(N, R, c);
          const tooSmall = p.segs.some((L) => L < 30);
          // 「提速不到 15% 就别多开」是 auto 的**启发式**(契约 G4 把它放在规划里),
          // 不是硬约束。显式写了 workers: 4 的人要的就是 4 个:编排短一点、
          // 单帧成本低一点,4 会在 N=2 上就被这条门槛砍掉,验证脚本里那组
          // 「静态 × 固定 4」永远拿不到 4,日志里的「选定的 N」和用例名对不上。
          // 只有「分段小于 30 帧」是两种情况都作废的硬约束 —— 段太碎时快进的
          // 沉没成本超过渲染本身,多开是纯亏。
          const worthIt = WORKERS_OPT !== "auto" || p.wall < 0.85 * prevWall;
          console.log(
            `workers: plan N=${N} 预计 ${p.wall.toFixed(1)}s 分段 ${p.segs.join("/")}` +
              (tooSmall ? "  ✗ 分段小于 30 帧" : worthIt ? "" : "  ✗ 提速不足 15%"),
          );
          // 分段太碎:再多开只会更碎,直接收手
          if (tooSmall) break;
          // 多一个浏览器就多几百 MB 内存和一次快进,提速不到 15% 不值当
          if (!worthIt) break;
          chosenN = N;
          chosenSegs = p.segs;
          prevWall = p.wall;
        }
        if (WORKERS_OPT !== "auto" && chosenN !== WORKERS_OPT) {
          console.log(`workers: 指定的 ${WORKERS_OPT} 个分不出合适的段,退到 ${chosenN}`);
        }
      }

      console.log(`workers: ${chosenN}`);
      const starts = [K + 1];
      for (let i = 1; i < chosenN; i++) starts.push(starts[i - 1] + chosenSegs[i - 1]);
      console.log(
        `workers: 分段 ` +
          chosenSegs
            .map((L, i) => `${i === 0 ? "主页面" : `工作器${i}`}@${starts[i]}×${L}`)
            .join(" / "),
      );

      // ---- 执行:主页面接着往下渲,工作器各自快进到自己的起点 ----
      const tasks = [renderFrames(page, client, K + 1, K + chosenSegs[0])];
      for (let i = 1; i < chosenN; i++) {
        const start = starts[i];
        const count = chosenSegs[i];
        tasks.push(
          (async () => {
            const w = await openRenderPage();
            try {
              await renderFrames(w.page, w.client, 1, start - 1, { shoot: false });
              await renderFrames(w.page, w.client, start, start + count - 1);
            } finally {
              // 渲完就放掉这几百 MB,别让 6 个 Chrome 一直挂到合成结束
              await closeBrowser(w.browser);
            }
          })(),
        );
      }
      // 先给每个任务挂一个空 catch:Promise.all 一旦被第一个错误拒绝,其余任务
      // 稍后再失败就成了 unhandledRejection,能把整个进程带崩(错误信息还不是真正的原因)
      for (const t of tasks) t.catch(() => {});
      await Promise.all(tasks);
    }
  }

  framesDone = true;

  // 烤入人物的时间段(导出页按「卡有没有 camSrc 控件」算好挂在 window 上)。
  // 趁浏览器还开着取出来,后面写进「合成说明」。
  const camSegs = await page.evaluate(() => window.__CAM_SEGMENTS ?? []).catch(() => []);

  // ---- PNG 序列 → 自动合成透明视频(需要本机 ffmpeg;没有则跳过,只留 PNG) ----
  const result = { ok: true, dir: outDir, frames: totalFrames, fps, mov: null, webm: null };
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (hasFfmpeg) {
    const seq = path.join(outDir, "frame_%06d.png");
    // 1) 剪映友好:ProRes 4444 透明 MOV(编码快,文件较大)→ 成品放 exports/output/
    console.log("composing MOV (ProRes 4444 alpha)...");
    const mov = path.join(finalDir, `${name}-${stamp}.mov`);
    const r1 = spawnSync(
      "ffmpeg",
      ["-y", "-framerate", FPS_ARG, "-i", seq,
        // 预乘 alpha(定案,勿再删)。剪映按**预乘**合成 ProRes 4444:
        // 它算的是 dst*(1-a) + c,而不是 dst*(1-a) + c*a。所以必须先把 RGB 乘上 alpha。
        //
        // 8/27 曾以"预乘会把半透明压暗一倍"为由删掉这行 —— 那次测法是错的:
        // 拿 MOV 的 RGB 通道直接叠黑底比亮度(120 vs 58),那测的是文件里的裸颜色,
        // 不是剪映合出来的画面;预乘后 RGB 本来就该变暗,合成时 alpha 不再乘第二遍才对得上。
        //
        // 8/28 用真成片回归验证(45s 整帧、按 alpha 分档比对预测值与实际像素):
        //   alpha 档     直通模型误差 / 预乘模型误差
        //   ≈全透明        16.58 / 1.78
        //   很淡           78.11 / 2.28
        //   半透明(玻璃)     8.08 / 0.90
        //   较实            4.93 / 2.97
        // 每一档都是预乘模型胜。不预乘的后果:全透明区的 RGB 是近白垃圾值,
        // 会被直接加进画面 —— ambient-wash 的羽化带因此在成片里烧成一圈椭圆白环。
        "-vf", "premultiply=inplace=1",
        "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0",
        // 色彩空间标记:不写的话 ffprobe 三项都是 unknown,剪映只能猜,
        // 猜错就整条偏色(实测:导进剪映后整条颜色不对)。原片是 bt709,对齐它。
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", mov],
      { stdio: "ignore" },
    );
    if (r1.status === 0 && fs.existsSync(mov)) {
      result.mov = mov;
    } else {
      // 失败多半是写到一半磁盘满了:半截 MOV 没有 moov 索引,留着只会被误当成成片
      fs.rmSync(mov, { force: true });
      result.ok = false;
      // 这里报的应该是成品真正落盘那块盘的余量
      result.error = `MOV 合成失败(磁盘还剩 ${gb(freeBytes(EXPORT_ROOT))}GB),半截文件已删除`;
      console.error(`\n【导出失败原因】${result.error}`);
    }
    // 2) 小体积:VP9 透明 WebM(编码稍慢;剪映不认 WebM 透明,给网页/达芬奇用)
    console.log("composing WebM (VP9 alpha)...");
    const webm = path.join(finalDir, `${name}-${stamp}.webm`);
    const r2 = spawnSync(
      "ffmpeg",
      ["-y", "-framerate", FPS_ARG, "-i", seq,
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
        "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0", webm],
      { stdio: "ignore" },
    );
    if (r2.status === 0 && fs.existsSync(webm)) result.webm = webm;
    else fs.rmSync(webm, { force: true });
  } else {
    console.log("ffmpeg not found — skip video composing, PNG sequence only");
  }

  // ---- 音效烤入:按每张卡的出现时刻把音效混成音轨,直接封进 MOV ----
  // 每卡可用参数 sfx 覆盖:留空 = 按类型自动;"none" = 静音;其余 = public/sfx/<名>.mp3
  if (mode === "timeline" && doc?.cards?.length && result.mov && hasFfmpeg) {
    const SFX_DIR = path.join(ROOT, "public", "sfx");
    const KIND_SFX = {
      // 计数/数据 → 数字上升
      "stat-proof": "rise", odometer: "rise", "number-beats": "rise", "ring-metric": "rise",
      "metric-focus": "rise", "bar-race": "rise", "rank-bars": "rise", "compare-split": "rise",
      "growth-curve": "rise", "diverge-lines": "rise",
      // 盖章/落锤/爆点/巨字 → 重击
      "strike-flip": "impact", "rule-card": "impact", "win-lose": "impact", "versus-card": "impact", "icon-veto": "impact",
      "word-flank": "impact", "burst-halo": "impact", "char-assemble": "impact",
      // 满屏运镜/转场 → 嗖
      "screen-demo": "whoosh", "focus-card": "whoosh", "focus-takeover": "whoosh",
      "punch-zoom": "whoosh", "cam-pan": "whoosh-soft", "doc-scroll": "whoosh-soft",
      "light-sweep": "sparkle", "glow-badges": "sparkle",
      // 照片/截图 → 快门;多图弹入 → 连环 pop
      "cover-stack": "shutter", "proof-shot": "shutter", "quote-cite": "shutter",
      "project-window": "shutter", "phone-shot": "shutter", "ui-callout": "shutter",
      "photo-halo": "pop-cluster", "magic-bento": "pop-cluster", "icon-pop": "pop", "formula-pill": "pop",
      // 打字/代码/故障
      "terminal-3d": "type", "type-shift": "type", "decrypt-text": "glitch", "letter-glitch": "glitch",
      // 结构/步骤/清单/名牌
      "chapter-bar": "chime", checklist: "ding", "step-timeline": "click", "stepper-flow": "click",
      "timeline-h": "click", "outline-tree": "click", "flow-chart": "click",
      "entity-chips": "click", "info-board": "click", "section-head": "whoosh-soft",
      // 氛围层不配音效
      "ambient-wash": null, "caption-track": null,
    };
    const DEFAULT_SFX = "pop-light";
    const points = doc.cards
      .map((c) => {
        const chosen = c.params?.sfx === "none"
          ? null
          : (c.params?.sfx || (c.kind in KIND_SFX ? KIND_SFX[c.kind] : DEFAULT_SFX));
        if (!chosen) return null;
        const file = path.join(SFX_DIR, `${chosen}.mp3`);
        if (!fs.existsSync(file)) return null;
        return { t: c.start, file, sfx: chosen, kind: c.kind };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
    if (points.length) {
      console.log(`baking ${points.length} sfx into MOV...`);
      // 1) 静音底轨(定全长)+ 每个音效裁 3.2s 渐出、延迟到卡片出现时刻,混成一条音轨
      const mixFile = path.join(outDir, "sfx-mix.m4a");
      const args = ["-y", "-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=44100:cl=stereo"];
      for (const p of points) args.push("-i", p.file);
      const ms = (t) => Math.max(0, Math.round(t * 1000));
      const chains = points.map(
        (p, i) =>
          `[${i + 1}]atrim=0:3.2,afade=t=out:st=2.7:d=0.5,volume=0.8,adelay=${ms(p.t)}|${ms(p.t)}[s${i}]`,
      );
      const mixIn = points.map((_, i) => `[s${i}]`).join("");
      args.push(
        "-filter_complex",
        `${chains.join(";")};[0]${mixIn}amix=inputs=${points.length + 1}:duration=first:normalize=0[out]`,
        "-map", "[out]", "-c:a", "aac", "-b:a", "192k", mixFile,
      );
      const rMix = spawnSync("ffmpeg", args, { stdio: "ignore" });
      // 2) 音轨封进 MOV(视频流原样拷贝,不重编码)
      if (rMix.status === 0 && fs.existsSync(mixFile)) {
        const tmp = result.mov.replace(/\.mov$/, "-audio.mov");
        const rMux = spawnSync(
          "ffmpeg",
          ["-y", "-i", result.mov, "-i", mixFile,
            // 音轨转 PCM 再封进 MOV。剪映读 .mov 里的 AAC 不稳:有一次导出
            // 音轨齐全(40 个点、max 0dB)但剪映里就是没声音,转成 pcm_s16le 后立刻正常。
            // 以前的导出同样是 AAC 且能出声(上一版成片 18.55/19.75/21.35s 都能测到音效),
            // 所以这不是必现问题 —— 但 PCM 是 MOV 的通用选择,只多约 30MB,直接默认给它。
            "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", tmp],
          { stdio: "ignore" },
        );
        if (rMux.status === 0 && fs.existsSync(tmp)) {
          fs.renameSync(tmp, result.mov);
          result.sfxBaked = points.length;
          console.log(`sfx baked: ${points.length} points`);
        }
      }
      // 3) 清单:记录烤了什么(想换音效:选中卡片 → 「音效」下拉 → 重导)
      const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
      const sheet = [
        `音效清单 · ${name}-${stamp}(已直接混入 MOV,无需手动加)`,
        "想调整:回 Studio 选中卡片 → 节奏组「音效」下拉换一个(选中即试听)或选「无音效」,重新导出。",
        "整条音效轨的音量在剪映里对 MOV 轨道统一调(建议比人声低,约 -12~-18dB)。",
        "",
        ...points.map((p) => `${fmt(p.t)}  ${p.kind.padEnd(14)}  ${p.sfx}`),
      ].join("\n");
      const sheetPath = path.join(finalDir, `${name}-${stamp}-音效清单.txt`);
      fs.writeFileSync(sheetPath, sheet, "utf8");
      result.sfxSheet = sheetPath;
    }
  }

  // ---- 合成说明:只在真的烤了人物时才生成 ----
  // 这几段的透明层里已经有一份人物画面,剪映里必须把原始口播轨盖住,
  // 否则会看到两层人。说明放在成品旁边,而不是 README —— 用户打开
  // exports/output/ 拿 MOV 的那一刻,正好是他要去剪映的前一秒。
  if (camSegs.length && result.mov) {
    const fmt2 = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    const note = [
      `合成说明 · ${name}-${stamp}`,
      "",
      "这条动效层里有 " + camSegs.length + " 段把口播人物烤了进去(运镜/取景类卡片)。",
      "剪映里这几段要把【原始口播轨盖住】,否则会看到两层人:",
      "",
      ...camSegs.map((s) => `  ${fmt2(s.start)} — ${fmt2(s.end)}   ${s.kind}`),
      "",
      "做法:把 MOV 放在最上层轨道,上面这几个时间段把下面的原始口播轨切开、静音或删掉画面",
      "(声音要留)。其余时间段照常,MOV 盖在原片上即可。",
    ].join("\n");
    const notePath = path.join(finalDir, `${name}-${stamp}-合成说明.txt`);
    fs.writeFileSync(notePath, note, "utf8");
    result.camNote = notePath;
  }

  // ---- 清理 PNG 中间目录:成片(MOV)到手后这几 GB 就没用了,默认删掉 ----
  // 合成失败或没装 ffmpeg 时保留:PNG 是几分钟渲染的成果,留着可手动重合成。
  if (result.mov && !keepFrames) {
    fs.rmSync(outDir, { recursive: true, force: true });
    result.dir = null;
    console.log("cleaned PNG frames dir");
  }

  // ---- 抽帧缓存:只留这次用到的 ----
  // 缓存键带着视频的 mtime,同一段口播换一版原片就再抽一份,旧的没人清(7 天那条只在
  // 下次导出时才跑)。用户盘满时翻不到这个目录 —— 它在 public/ 下面,名字还带下划线。
  // 换视频重导要多等一次抽帧(几分钟),换来的是磁盘不会悄悄长几个 G;对客户,盘更稀缺。
  {
    const used = new Set(Object.values(vidFrames).map((m) => path.basename(m.dir)));
    let n = 0;
    if (fs.existsSync(cacheRoot))
      for (const d of fs.readdirSync(cacheRoot))
        if (!used.has(d)) {
          fs.rmSync(path.join(cacheRoot, d), { recursive: true, force: true });
          n++;
        }
    if (n) console.log(`cleaned ${n} unused video-frame cache dir(s)`);
  }

  console.log(JSON.stringify(result));
} catch (e) {
  // 渲染到一半崩了:半成品 PNG 没用,别留几个 G 在 exports/ 里(界面上只会说「导出失败」,
  // 用户不知道还有这么一堆)。渲染完了才崩(合成阶段)的 PNG 是完整的,照旧保留。
  if (!framesDone && !keepFrames && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
    console.error("渲染没做完,已清掉半成品 PNG 目录");
  }
  // 人话原因放在 stderr 结尾(接口取尾部展示给用户)
  console.error(String(e?.stack ?? e));
  // puppeteer 的 "Protocol error (…): Target closed" 只说明「CDP 那头没了」,对用户是天书。
  // 实测(2026-09-06):带视频卡的编排在并行模式下约三成的跑会撞到它 —— 每个工作器都是一个
  // 独立的 Chrome,而视频卡要把整条 _fxframes 序列逐帧换进页面,N 个浏览器同时干这件事时
  // 渲染进程会被系统按内存干掉,下一次 captureScreenshot 就找不到目标了。不带视频卡的编排
  // 从没复现过。所以这里翻成人话,并给出可操作的出路(把 workers 调小 / 设成 1)。
  const rawMsg = String(e?.message ?? e).split("\n")[0];
  const targetGone = /Target closed|Session closed|Protocol error/i.test(rawMsg);
  console.error(
    `\n【导出失败原因】${rawMsg}` +
      (targetGone
        ? `\n(渲染器中途退出了。并行导出时每个工作器都是一个独立的 Chrome,带视频的编排最吃内存,` +
          `机器紧张时系统会挑一个杀掉。把 workers 调小、或设成 1 走单进程,通常就能过。)`
        : ""),
  );
  process.exitCode = 1;
} finally {
  // 假死的渲染器连 close 都可能不回:给 10 秒,不回就直接杀进程,别让「收尾」再挂一次。
  // 并行时开过的每一个都要收:哪怕工作器自己已经关过一次,再关一次也是安全的。
  await Promise.all(openedBrowsers.map((b) => closeBrowser(b)));
}
