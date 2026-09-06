#!/usr/bin/env node
/**
 * 导出模式一致性验证(契约 V.1)
 *
 * 同一份编排、同一套参数,分别用「服务器模式 / 静态模式」×「串行 / 自动并行 / 固定并行」
 * 各跑一次导出,逐帧比对 PNG 的 sha256:换了路径不换像素。
 *
 * 判定口径分三档,原因是**作者原版的效果库本身就不是逐帧确定的**:
 * `src/effects/useAnimation.ts` 的 `useEnter` 用两层 rAF 翻 `entered` 来触发 CSS 过渡,
 * 「哪一帧翻」取决于虚拟时间推进期间实际跑掉几次 rAF,于是**每张卡的进场窗口**都会抖。
 * 本轮不许改 src/ 去修它,所以:
 *
 *   ① 完整编排 → 噪声包络。每种配置都跑**两遍**(server1/server1b、static1/static1b、
 *      staticAuto/staticAutob、static4/static4b),同配置两遍之间的不一致帧数就是本底噪声 noise;
 *      静态/并行对基线的差异只要不超过 max(1.5×noise, noise+10) 就算过。
 *   ② 分段边界 → 硬判据。噪声恰好覆盖各卡进场区间,而「快进和渲染路径不等价」造成的
 *      并行 bug 也正是一整段进场过渡,只看 ① 会把它放过(2026-09-06 实测教训:30 帧的
 *      边界块就藏在噪声里)。所以另外盯每个工作器分段起点 s_i 后的 40 帧,
 *      判「从 s_i 那一帧起是否有连续差异块」,并和同配置复跑在同区间的差异对照。
 *   ③ css-only 子集(加 --css-only)→ 严格逐帧一致,容差 0。
 *      只留进场确定的卡(见下面 CSS_ONLY_KINDS),这一档必须一帧不差 ——
 *      它才是「静态模式/并行没有改变渲染」的真正证据。
 *      实测(2026-09-06,demo 编排、854 帧):静态×1 两次 + 静态×3,三者逐帧完全一致。
 *
 * 一次完整验收要跑两遍:
 *   node scripts/verify-export-modes.mjs --app <motion-playground>
 *   node scripts/verify-export-modes.mjs --app <motion-playground> --css-only
 *
 * 用法:
 *   node scripts/verify-export-modes.mjs [选项]
 *     --doc <overlay.json>   编排文件,默认 runtime/app/public/demo/demo-overlay.json
 *     --app <目录>           跑导出的应用目录(motion-playground 或 runtime/app),默认 runtime/app
 *     --out <目录>           中间产物根目录,默认 %TEMP%\ovs-verify
 *     --modes <a,b,c>        要跑的组合,默认每种配置各跑两遍:
 *                            server1,server1b,static1,static1b,staticAuto,staticAutob,static4,static4b
 *                            列表里的第一个是基线,带 b 的是同配置复跑(噪声标尺 + 边界检查的参照),
 *                            其余都跟基线比;去掉标尺就等于要求容差 0(脚本会明说)
 *     --port <n>             服务器模式临时 vite 的端口,默认 5199(避开用户在用的 5177)
 *     --css-only             只保留画面由 CSS 驱动的卡,容差 0(见上面 ②)
 *     --keep                 跑完不删中间目录(要人工看帧的时候用)
 *     --no-ffmpeg            不把 runtime/ffmpeg 塞进子进程 PATH。导出会跳过 MOV/WebM 合成,
 *                            只留 PNG —— 这一档判的就是 PNG,合成一遍要多花一倍多的墙钟时间。
 *                            **带视频卡的编排不能用**:抽帧(_fxframes)本身要 ffmpeg,缺了会直接失败。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(__dirname, "..");

// ---- 组合定义 ----
// staticDir 是否设、workers 取什么值,决定 export-frames.mjs 走哪条代码路径。
// 名字就是产物子目录名,出问题时人能直接照着名字翻目录。
const MODES = {
  server1: { static: false, workers: 1, desc: "服务器模式 × workers=1(基线)" },
  // 噪声标尺:某个组合原样再跑一遍,noiseOf 指向它复跑的是谁。
  // 两遍之间的不一致帧数就是那条路径的本底噪声,静态/并行组合的容差按最大的那个算。
  // 没有这些就没法区分「静态模式引入的差异」和「原版效果库本来就有的抖动」——
  // 那样要么冤枉静态模式,要么只能把红线整个放弃。
  // 两条都要:实测服务器模式复跑差 20 帧,静态模式复跑差七八十帧 —— 两条路径的抖动
  // 量级本来就不同,只拿服务器那条当尺子会把静态模式判成「引入了差异」。
  server1b: { static: false, workers: 1, desc: "服务器模式 × workers=1(复跑,量本底噪声)", noiseOf: "server1" },
  static1b: { static: true, workers: 1, desc: "静态模式 × workers=1(复跑,量静态路径的本底噪声)", noiseOf: "static1" },
  static1: { static: true, workers: 1, desc: "静态模式 × workers=1" },
  staticAuto: { static: true, workers: "auto", desc: "静态模式 × workers=auto" },
  static4: { static: true, workers: 4, desc: "静态模式 × workers=4" },
  // 并行组合也要各自复跑一遍。理由不只是「量噪声」:下面的分段边界检查要拿
  // 「同配置重跑在同一窗口的差异」当参照 —— 边界正好落在某张卡的进场窗口里时,
  // 那里本来就有噪声,没有参照就分不清「边界块」和「进场抖动」。
  staticAutob: { static: true, workers: "auto", desc: "静态模式 × workers=auto(复跑)", noiseOf: "staticAuto" },
  static4b: { static: true, workers: 4, desc: "静态模式 × workers=4(复跑)", noiseOf: "static4" },
};

// 分段边界窗口宽度:实测最长的进场过渡是 30 帧(odometer),留到 40 帧。
// 「快进和渲染路径不等价」这个 bug 的特征是**从 s_i 那一帧起**连续错一整段过渡,
// 所以只要盯住 [s_i, s_i+40) 就能抓到它(见 DESIGN.md 第二轮红线第 2 条)。
const BOUNDARY_WIN = 40;

// ---- 参数 ----
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "keep") out.keep = true;
    else if (key === "css-only") out.cssOnly = true;
    else if (key === "no-ffmpeg") out.noFfmpeg = true;
    else out[key] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const APP = path.resolve(args.app ?? path.join(DESKTOP, "src-tauri", "runtime", "app"));
const DOC = path.resolve(args.doc ?? path.join(APP, "public", "demo", "demo-overlay.json"));
const OUT = path.resolve(args.out ?? path.join(os.tmpdir(), "ovs-verify"));
const PORT = Number(args.port ?? 5199);
const KEEP = !!args.keep;
const CSS_ONLY = !!args.cssOnly;
const NO_FFMPEG = !!args.noFfmpeg;
const MODE_NAMES = String(
  args.modes ?? "server1,server1b,static1,static1b,staticAuto,staticAutob,static4,static4b",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function die(msg) {
  console.error(`\n【验证中止】${msg}`);
  process.exit(1);
}

for (const m of MODE_NAMES) if (!MODES[m]) die(`不认识的组合 "${m}",可选:${Object.keys(MODES).join(", ")}`);
if (!MODE_NAMES.length) die("--modes 是空的,没什么可跑");
if (!fs.existsSync(DOC)) die(`编排文件不存在:${DOC}`);
if (!fs.existsSync(path.join(APP, "scripts", "export-frames.mjs")))
  die(`--app 指向的目录里没有 scripts/export-frames.mjs:${APP}`);

// runtime/app 是 prepare-runtime 复制出来的副本,会落后于 motion-playground。
// 落后的时候脚本照样能跑完、照样【通过】,但验的是上一版代码 —— 红线检查变成了盖章机。
// 所以开跑前先对一下导出脚本的 sha256,不一致就停,让人先同步(契约第 6 条的 appSrcHash 是同一个意思)。
const MP = path.resolve(DESKTOP, "..", "motion-playground");
const sha256File = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
if (path.resolve(APP) !== MP && fs.existsSync(path.join(MP, "scripts", "export-frames.mjs"))) {
  const a = sha256File(path.join(APP, "scripts", "export-frames.mjs"));
  const b = sha256File(path.join(MP, "scripts", "export-frames.mjs"));
  if (a !== b)
    die(
      `--app 的导出脚本和 motion-playground 那份不一致,验的会是旧代码:\n` +
        `  ${path.join(APP, "scripts", "export-frames.mjs")}\n    sha256 ${a}\n` +
        `  ${path.join(MP, "scripts", "export-frames.mjs")}\n    sha256 ${b}\n` +
        `先跑 npm run prepare-runtime(或 node scripts/prepare-runtime.mjs --check 看还差什么),` +
        `或者直接 --app ${MP} 验上游那份。`,
    );
}

// ---- 导出参数 ----
// 时长取「最后一张卡的 end + 0.5 秒」:尾巴上那半秒是留给收尾动画的,
// 跟用户在界面上导出整条时间轴时算出来的长度一致。
const docJson = JSON.parse(fs.readFileSync(DOC, "utf8"));

// --css-only:摘掉「进场时刻由 rAF 决定」的卡,留下重跑必然一模一样的那些。
//
// 【2026-09-06 更正,原来这份名单是反的】原来摘的是 caption-track / chapter-bar /
// stat-proof / type-shift,理由是它们走 useTimelineTime / useCountUp / useElapsed。
// 实测下来那条理由不成立:这三个钩子在导出模式下都有 `useExportMs` 这条**确定性通路**
// (src/effects/useAnimation.ts —— 渲染期直接由 __fxExportMs 算出数值,不经过
// rAF→setState),`__fxClockRate` 也被 export-frames.mjs 的 evaluateOnNewDocument
// 钉死成 1,两者都不是噪声来源。
//
// 真正不确定的是 `useEnter`:它用**两层 rAF** 把 entered 翻成 true 来触发 CSS 过渡,
// 「哪一帧翻」取决于这段虚拟时间推进期间实际跑掉几次 rAF。所以噪声全部落在**各卡
// (以及卡内逐项)的进场窗口**上。实测 demo 编排、静态串行重跑:
//   pin-board 6-30 / 62-75 / 107-120,step-timeline 169-252,odometer 261-290,
//   checklist 357-374,focus-card 453-487,versus-card 525-574,stat-proof 647-665,
//   type-shift 696-742 —— 每一段都精确对应一次进场;两张全程铺底、不做分项进场的卡
//   (chapter-bar / caption-track)则从头到尾一帧不差。
// 只留这两张跑出来的结果:静态×1 两次 + 静态×3,854 帧逐帧 sha256 完全一致。
//
// 所以名单改成白名单。名单变了要同步这里 —— 判据写死在验证脚本里比写在文档里更难烂掉。
const CSS_ONLY_KINDS = new Set(["chapter-bar", "caption-track"]);
if (CSS_ONLY) {
  const before = Array.isArray(docJson.cards) ? docJson.cards.length : 0;
  docJson.cards = (docJson.cards ?? []).filter((c) => CSS_ONLY_KINDS.has(String(c?.kind)));
  const dropped = before - docJson.cards.length;
  if (!docJson.cards.length)
    die(
      `--css-only 把编排里的卡全摘光了(原有 ${before} 张):这份编排里没有 ` +
        `${[...CSS_ONLY_KINDS].join(" / ")},换一份带这两种卡的编排再跑这一档`,
    );
  console.log(
    `[css-only] 只留 ${docJson.cards.length} 张进场确定的卡(${[...CSS_ONLY_KINDS].join(" / ")}),` +
      `摘掉 ${dropped} 张靠 useEnter 触发进场过渡的`,
  );
}

const cards = Array.isArray(docJson.cards) ? docJson.cards : [];
const lastEnd = cards.reduce((m, c) => Math.max(m, Number(c?.end) || 0), 0);
const FPS = 29.97;
const DURATION = Number((lastEnd + 0.5).toFixed(3));
if (!(DURATION > 0.5)) die(`编排里没有带 end 的卡片,算不出时长:${DOC}`);
// 帧数算式必须和 export-frames.mjs 第 84 行的 isNTSC 分支一字不差:
// 那边 29.97 走的是精确分数 30000/1001,这边要是按 29.97 这个小数取整,
// 枚举 1~180 秒的毫秒级时长有 0.27% 的点两边取整结果差 1(例如 17.334s → 519 vs 520),
// 于是脚本会打「应有 519 帧、实际 520 个 PNG」判不通过 —— 让人去追一个不存在的 bug。
const EFF_FPS = Math.abs(FPS - 29.97) < 0.01 ? 30000 / 1001 : FPS;
const TOTAL_FRAMES = Math.max(1, Math.round(DURATION * EFF_FPS));

// ---- 子进程环境 ----
// 会话 PATH 上通常没有 ffmpeg,导出的抽帧和合成会静默降级;puppeteer 也要知道
// Chrome for Testing 在哪。runtime 布局里这两样就在 app 的同级目录,能自己补上就自己补,
// 免得每次跑验证都要先手动配环境(配漏了得到的是"能跑但产物不对",更难查)。
const RUNTIME = path.resolve(APP, "..");
function baseEnv() {
  const env = { ...process.env, BROWSER: "none" };
  const ffdir = path.join(RUNTIME, "ffmpeg");
  // --no-ffmpeg:故意不补 ffmpeg。export-frames.mjs 探不到就跳过 MOV/WebM 合成,
  // 一轮八种组合能省下一半以上的墙钟时间,而这个脚本判的是 PNG,合成产物不参与判定。
  // (合成链路交给装好的包那一遍冒烟去验 —— 那边跑的是真实用户路径,ffmpeg 就在 runtime 里。)
  if (!NO_FFMPEG && (fs.existsSync(path.join(ffdir, "ffmpeg.exe")) || fs.existsSync(path.join(ffdir, "ffmpeg"))))
    env.PATH = `${ffdir}${path.delimiter}${env.PATH ?? ""}`;
  const chromeDir = path.join(RUNTIME, "chrome");
  if (!env.PUPPETEER_CACHE_DIR && fs.existsSync(chromeDir)) env.PUPPETEER_CACHE_DIR = chromeDir;
  // workers 一律走 job 字段;环境变量留着会盖掉逐组合的设定,直接抹掉最省事
  delete env.OVERLAY_EXPORT_WORKERS;
  delete env.OVERLAY_EXPORT_STATIC_DIR;
  return env;
}

// ---- 小工具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function httpOk(url, timeoutMs = 2000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function run(cmd, cmdArgs, opts = {}) {
  // 子进程的 stdout/stderr 一边转发到终端(跑十几分钟得看得见动静),一边留一份完整的给后面解析
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => {
      const s = String(b);
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (b) => {
      const s = String(b);
      err += s;
      process.stderr.write(s);
    });
    child.on("error", (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// ---- 静态模式前置:重建 dist ----
// 无条件重建,不看 dist 在不在。旧的 dist 拿去跟服务器模式跑的当前源码比,
// 结论跟被审的代码没关系:方向对了会假报「20 帧不一致」,方向反了(dist 陈旧但和旧源码自洽)
// 四种组合会一起【通过】,而真正要验的新代码一帧都没跑过。
// 契约 F 节写的是「npx vite build 1 秒出 dist」,实测 128ms,没有省这一步的理由。
async function ensureDist() {
  const idx = path.join(APP, "dist", "index.html");
  // 直接用当前 node 跑 vite 的入口,不走 npx.cmd:Node 20 起在 Windows 上 spawn 一个 .cmd
  // 会 EINVAL(除非 shell:true),而 shell:true 又要操心引号转义。startVite 也是这么起的。
  const bin = path.join(APP, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(bin)) die(`找不到 vite:${bin}(先在该目录 npm ci)`);
  console.log(`[dist] 无条件重建(旧构建会让比对验错代码):vite build @ ${APP}`);
  const t0 = Date.now();
  const r = await run(process.execPath, [bin, "build"], { cwd: APP, env: baseEnv() });
  if (r.code !== 0 || !fs.existsSync(idx)) die(`vite build 失败(退出码 ${r.code}),静态模式没法跑`);
  console.log(`[dist] 构建完成,用时 ${fmtSec(Date.now() - t0)}:${idx}`);
}

// 端口上有没有人在听。strictPort 只保证「我们这个 vite 不会换口」,
// 拦不住「端口已经被别人占着」:vite 因为端口冲突退出要一秒左右,而占端口的那位
// 在第一次轮询(t=0)就返回 200,轮询会当场认账,把导出指向别人的服务。
function portBusy(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// ---- 服务器模式前置:自己起一个临时 vite ----
// 端口用 --port 传进来的(默认 5199),不碰用户正在用的 5177。
async function startVite() {
  if (await portBusy(PORT))
    die(
      `端口 ${PORT} 已经被别的进程占着,换一个 --port。` +
        `(占着它的如果是你自己开着的 Overlay Studio,导出会静默跑在那个实例上,基线就不是这份代码的基线了)`,
    );
  console.log(`[vite] 启动 ${APP} 上的 dev server(127.0.0.1:${PORT})...`);
  const bin = path.join(APP, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(bin)) die(`找不到 vite:${bin}(先在该目录 npm ci)`);
  const child = spawn(process.execPath, [bin, "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: APP,
    env: baseEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += String(b)));
  child.stderr.on("data", (b) => (log += String(b)));
  let exited = false;
  child.on("close", () => (exited = true));

  const url = `http://127.0.0.1:${PORT}/`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) die(`vite 起不来,它的输出:\n${log}`);
    // 200 不够:还要求这个 child 活着、并且它自己已经喊过 ready/Local,
    // 才能确认这个 200 是它给的,而不是抢在它前面的另一个服务给的。
    const selfAnnounced = /ready in|Local:\s*http/i.test(log);
    if (selfAnnounced && !exited && (await httpOk(url))) {
      console.log(`[vite] 就绪 ${url}`);
      return child;
    }
    await sleep(300);
  }
  try {
    child.kill();
  } catch {}
  die(`90 秒内 ${url} 没返回 200,vite 输出:\n${log}`);
}

function stopVite(child) {
  if (!child || child.exitCode !== null) return;
  // vite 下面还挂着 esbuild 之类的子进程,Windows 上必须 /T 整棵树杀,
  // 否则端口会被残留进程占着,下次跑 strictPort 直接失败。
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {}
}

// ---- 跑一种组合 ----
async function runMode(name) {
  const cfg = MODES[name];
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    mode: "timeline",
    doc: docJson,
    fps: FPS,
    duration: DURATION,
    keepFrames: true, // 逐帧比对全靠它,PNG 不留就没得比
    scale: 1,
    speed: 1,
    workers: cfg.workers,
  };
  if (cfg.static) {
    job.staticDir = path.join(APP, "dist");
    // 静态模式故意把 base 指向一个解析不了的主机:万一 export-frames.mjs 还没认 staticDir,
    // 它会拿 base 的默认值 http://localhost:5177 —— 那是用户自己开着的编辑台,
    // 结果就是「静态模式」其实走了服务器,帧当然一致,验证白做还看不出来。
    // 指到 .invalid 上,没实现 staticDir 就直接连不上、当场失败,比蒙混过关强。
    job.base = "http://static-mode-must-not-use-base.invalid";
  } else {
    job.base = `http://127.0.0.1:${PORT}`;
  }

  const jobFile = path.join(dir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));

  const env = baseEnv();
  env.OVERLAY_EXPORT_DIR = dir;

  console.log(`\n========== ${name}:${cfg.desc} ==========`);
  const t0 = Date.now();
  const r = await run(process.execPath, [path.join("scripts", "export-frames.mjs"), jobFile], {
    cwd: APP,
    env,
  });
  const ms = Date.now() - t0;
  fs.writeFileSync(path.join(dir, "export.log"), r.out + "\n----- stderr -----\n" + r.err);

  // 从 stdout 里捞出并行相关的日志:workers 行、规划表、以及最后那行结果 JSON
  const lines = r.out.split(/\r?\n/);
  const planLines = lines.filter((l) => /workers|worker|规划|环境上限|plan|分段|N=/i.test(l));
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        result = JSON.parse(s);
        break;
      } catch {}
    }
  }
  // 表格那一列要填「实际选定的并行度」,不能填「请求值」。
  // export-frames.mjs 里以 workers: 开头的行有一堆(env / probe / plan / 分段 / 指定的…),
  // 靠 find 取第一条必然抓到探测行 —— 80 字符宽把表撑烂,而真正的结论反而看不见;
  // 一条都没有时回填 cfg.workers 更糟:并行还没实现的版本也会照常显示「4」配「逐帧一致」。
  // 所以只认结论行:`workers: <数字>` 后面要么行尾,要么紧跟一个 "(…)" 的说明
  // (`workers: 1(总帧数 60、环境上限 1,不值得并行)` 也是结论),并取最后一条。
  let workersActual = null;
  for (const l of lines) {
    const m = /^\s*workers:\s*(\d+)\s*(?:$|[((])/.exec(l);
    if (m) workersActual = m[1];
  }
  const want = String(cfg.workers);
  const workersPick =
    workersActual == null
      ? "未报告"
      : workersActual === want
        ? workersActual
        : `${want}→${workersActual}`; // 降级(请求 4 实得 1)必须显式写出来,别让它悄悄消失

  return {
    name,
    cfg,
    dir,
    ms,
    code: r.code,
    result,
    planLines,
    workersPick,
    workersActual,
    tail: r.err.trim().split(/\r?\n/).slice(-6).join("\n"),
  };
}

// ---- 帧哈希 ----
// keepFrames 的产物在 <OVERLAY_EXPORT_DIR>/timeline-<时间戳>/frame_%06d.png。
// 时间戳是导出脚本自己生成的,这里按目录名找、且只允许有一个,免得比错了目录还以为通过了。
function frameDir(dir) {
  const hits = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^timeline-/.test(d.name))
    .map((d) => path.join(dir, d.name));
  if (hits.length !== 1) return null;
  return hits[0];
}

// 返回 Map<文件名, sha256>,而不是数组。
// 用数组按下标对齐是个陷阱:只要某个工作器少写了中间一段(并行最容易翻的车),
// 两个数组从缺口起整体错位,后面每一帧都被判成不一致,打印出的「不一致帧号」全是错的,
// 人照着那些帧号去翻图只会查到无关的帧。按文件名对齐则缺口就是缺口,其余帧照常比。
function hashFrames(fdir) {
  const files = fs.readdirSync(fdir).filter((f) => /^frame_\d+\.png$/i.test(f)).sort();
  const m = new Map();
  for (const f of files)
    m.set(f, crypto.createHash("sha256").update(fs.readFileSync(path.join(fdir, f))).digest("hex"));
  return m;
}

// 从规划日志里捞每个工作器的分段起点。export-frames.mjs 打的是:
//   workers: 分段 主页面@61×293 / 工作器1@354×255 / 工作器2@609×246
// 主页面那一段不算边界(它是从探测帧接着往下渲的,没有快进),只取「工作器N@起点」。
function segStarts(planLines) {
  const l = (planLines ?? []).find((x) => /分段\s*主页面@/.test(x));
  if (!l) return [];
  return [...l.matchAll(/工作器\d+@(\d+)[×x]/g)].map((m) => Number(m[1]));
}

// frame_000123.png → 123。文件名是 export-frames.mjs 用 %06d 写的全局帧号,
// 帧号来自文件名而不是数组下标,人拿这个号能直接找到对应的 PNG。
function frameNo(file) {
  const m = /^frame_(\d+)\.png$/i.exec(file);
  return m ? parseInt(m[1], 10) : -1;
}

// 按文件名取并集比对:两边都有 → 比 hash;只有一边有 → 记成缺帧,单独列出来。
function compareFrames(frames, baseFrames) {
  const keys = [...new Set([...frames.keys(), ...baseFrames.keys()])].sort();
  const diff = [];
  const missing = [];
  for (const k of keys) {
    const a = frames.get(k);
    const b = baseFrames.get(k);
    if (a == null || b == null) missing.push(`${frameNo(k)}${a == null ? "(本组合缺)" : "(基线缺)"}`);
    else if (a !== b) diff.push(frameNo(k));
  }
  return { diff, missing };
}

// ---- 主流程 ----
let vite = null;
let exitCode = 0;
try {
  console.log(`编排   : ${DOC}`);
  console.log(`应用   : ${APP}`);
  console.log(`产物   : ${OUT}`);
  console.log(`参数   : fps=${FPS} duration=${DURATION}s(最后一张卡 end=${lastEnd} + 0.5),应有 ${TOTAL_FRAMES} 帧`);
  console.log(`组合   : ${MODE_NAMES.join(", ")}(基线 = ${MODE_NAMES[0]})\n`);

  fs.mkdirSync(OUT, { recursive: true });

  if (MODE_NAMES.some((m) => MODES[m].static)) await ensureDist();
  if (MODE_NAMES.some((m) => !MODES[m].static)) vite = await startVite();

  const runs = [];
  for (const name of MODE_NAMES) {
    const res = await runMode(name);
    runs.push(res);
    if (res.code !== 0) {
      console.error(`\n[${name}] 导出失败,退出码 ${res.code}`);
      if (res.tail) console.error(res.tail);
      exitCode = 1;
    }
    // 服务器模式跑完就把 vite 关了,后面的静态组合不该再依赖端口
    // (顺带也验证了静态模式确实不需要服务器)
    if (vite && !MODE_NAMES.slice(MODE_NAMES.indexOf(name) + 1).some((m) => !MODES[m].static)) {
      stopVite(vite);
      vite = null;
      console.log(`[vite] 已关闭`);
    }
  }

  // ---- 逐帧比对 ----
  // 先把每种组合的帧哈希都算出来,再决定容差:容差要用 server1b(噪声标尺)跟基线的
  // 差异算,而它可能排在别的组合后面,边算边判会拿到还没成型的容差。
  const scans = runs.map((res) => {
    const fdir = res.code === 0 ? frameDir(res.dir) : null;
    return { res, frames: fdir ? hashFrames(fdir) : new Map() };
  });
  const baseScan = scans[0];
  const baseline = { name: baseScan.res.name, frames: baseScan.frames };

  // 每种组合跟谁比:噪声标尺跟它复跑的那一条比(server1b↔server1、static1b↔static1),
  // 其余一律跟基线比。噪声标尺要是跟基线比,量出来的就是「路径差异+抖动」的混合值,
  // 拿它当尺子等于用要测的东西当刻度。
  for (const s of scans) {
    const against = MODES[s.res.name].noiseOf;
    const target = against ? scans.find((x) => x.res.name === against) : baseScan;
    if (!target) die(`组合 ${s.res.name} 要跟 ${against} 比,但 --modes 里没有 ${against}`);
    s.against = target.res.name;
    s.cmp =
      s.res.name === target.res.name
        ? { diff: [], missing: [] }
        : compareFrames(s.frames, target.frames);
  }

  // ---- 严格档的开头豁免 ----
  // css-only 子集里剩下的卡也用 useEnter,只不过它们都在 t=0 挂载,所以那次两层 rAF 的
  // 抖动只影响**开头这一次进场过渡**(实测 20 帧 ≈ 0.65s,和过渡时长对得上)。
  // 这一段的抖动和静态/并行无关:实测 static4 与 static4b(同一份配置、同一条代码路径、
  // 连着跑两遍)也恰好在第 1-20 帧上分成两种状态,而第 21 帧之后 854 帧一帧不差。
  // 所以严格档跳过开头 CSS_ONLY_SKIP 帧,并把这件事明着打出来 —— 不是放宽判据,
  // 是把「应用层在 t=0 的双稳态」从「导出路径是否改变了渲染」里摘出去。
  const CSS_ONLY_SKIP = 30;
  if (CSS_ONLY) {
    let dropped = 0;
    for (const s of scans) {
      const before = s.cmp.diff.length;
      s.cmp.diff = s.cmp.diff.filter((n) => n > CSS_ONLY_SKIP);
      dropped += before - s.cmp.diff.length;
    }
    console.log(
      `\n[判定] --css-only 跳过开头 ${CSS_ONLY_SKIP} 帧(t=0 进场过渡窗口,同配置重跑也会分成两种状态),` +
        `本次因此排除 ${dropped} 帧;第 ${CSS_ONLY_SKIP + 1} 帧之后必须一帧不差`,
    );
  }

  // ---- 分段边界检查(契约第二轮红线第 2 条)----
  // 光看「差异帧是否落在噪声集之内」会漏掉真正的并行 bug:应用层的固有噪声恰好覆盖了
  // 各卡的进场区间,而「快进和渲染路径不等价」造成的差异也正是一整段进场过渡,
  // 于是边界块就藏在噪声里了(2026-09-06 实测:那个 30 帧的块确实被这套判据放过了)。
  // 加一条对齐判据:块的起点精确等于某个工作器的分段起点 s_i,块长等于当时在途的过渡时长,
  // s_i 一动块就跟着动 —— 噪声不会有这个性质。
  //
  // 判死的条件收得很紧,只认这个特征本身:s_i 那一帧起**连续 5 帧**都和基线不一致,
  // 而同配置复跑在 s_i 这一帧是一致的(= 这不是这台机器在这个位置的固有抖动)。
  // 只是「窗口里有几帧差异」不判死,因为分段起点有可能正好落在某张卡的进场窗口里,
  // 那里两次同配置重跑本来就对不上 —— 所以窗口里的两个数字都打出来给人看。
  //
  // 【2026-09-06 补第三条判据:s_i 本身不能落在任何一条路径的本底噪声里】
  // 上面那句「噪声不会有这个性质」实测不成立。本轮 demo 编排上,自动缩放挑的
  // 工作器4 分段起点 s=711 正好落在 stat-proof 的分项进场窗口(696-742)里,于是:
  //   - staticAuto 与基线 static1 在 [711,742] 上连续 32 帧不一致 → runLen=32;
  //   - 同配置复跑 staticAutob 在 711 这一帧恰好和 staticAuto 一致 → 上面两条判据全中,判死。
  // 但**两次串行**(static1 vs static1b,workers=1,根本没有分段边界)在同一区间
  // 也是整段 696-742 不一致 —— 也就是说这个块跟并行毫无关系,是 useEnter 在这张卡上的双稳态。
  // 佐证:分段起点是 291/486/674 的 static4(711 附近没有任何边界)对基线同样差 696-742。
  // 所以再加一条:s_i 这一帧只要在**任何一条路径的复跑噪声**里出现过,就不能拿它当边界块的证据。
  // 这不是放宽 —— 真正的快进 bug 的块起点落在噪声之外(上一轮实测:噪声集
  // {30,74,119,357-374,382-396,408-421},块在 268-297,完全不重叠),这条判据照样抓得住它。
  const boundaryBad = new Set();
  const boundaryRows = [];
  const inWin = (arr, s) => arr.filter((n) => n >= s && n < s + BOUNDARY_WIN);
  // 本底噪声帧集:所有「同配置复跑」对里出现过的帧号并集(串行那对也在里面)
  const noiseFrames = new Set();
  for (const x of scans) if (MODES[x.res.name].noiseOf) for (const n of x.cmp.diff) noiseFrames.add(n);
  for (const s of scans) {
    const starts = segStarts(s.res.planLines);
    if (!starts.length || MODES[s.res.name].noiseOf) continue; // 复跑那条已经是参照,不重复判
    // 参照 = 指着自己的那条复跑(它的 cmp 就是「同配置两次之间的差异」)
    const twin = scans.find((x) => MODES[x.res.name].noiseOf === s.res.name);
    for (const st of starts) {
      const cross = inWin(s.cmp.diff, st);
      const rep = twin ? inWin(twin.cmp.diff, st) : null;
      // 从 s_i 起连续多少帧不一致
      let runLen = 0;
      while (cross.includes(st + runLen)) runLen++;
      const inNoise = noiseFrames.has(st);
      const bad = runLen >= 5 && !(rep && rep.includes(st)) && !inNoise;
      if (bad) boundaryBad.add(s.res.name);
      boundaryRows.push({ name: s.res.name, st, cross: cross.length, rep: rep ? rep.length : null, runLen, inNoise, bad });
    }
  }

  // 容差:噪声标尺跟基线差多少帧,就允许静态/并行的组合差多少(留 1.5 倍或 +10 的余量)。
  // 没跑噪声标尺(--modes 里没有 server1b)就退回 0 容差,并在结论里说清楚。
  const noiseScans = scans.filter((s) => MODES[s.res.name].noiseOf);
  const noise = noiseScans.length ? Math.max(...noiseScans.map((s) => s.cmp.diff.length)) : null;
  const TOL = noise == null ? 0 : Math.max(Math.ceil(noise * 1.5), noise + 10);
  for (const s of noiseScans)
    console.log(`[判定] 噪声标尺 ${s.res.name} vs ${s.against}:${s.cmp.diff.length} 帧不一致`);
  if (CSS_ONLY) {
    // css-only 子集里没有按 JS 钟渲染的卡,本来就该一帧不差 —— 这一档不吃容差,
    // 否则「严格一致」的证据就被噪声包络稀释掉了。
    console.log(`\n[判定] --css-only:容差 0(子集里只剩进场确定的卡,除开头那 ${CSS_ONLY_SKIP} 帧外必须逐帧一致)`);
  } else if (noise == null) {
    console.log(`\n[判定] 没跑噪声标尺 server1b,容差按 0 算(结论只能当作「上限」看)`);
  } else {
    console.log(
      `\n[判定] 本底噪声 = ${noise} 帧(取各条路径复跑差异的最大值),` +
        `容差 = max(1.5×${noise}, ${noise}+10) = ${TOL} 帧`,
    );
  }
  // 噪声本身大到一定程度,这条包络就没有区分力了(容差比要查的差异还宽)。
  // 不判死 —— 噪声是原版效果库的属性,不是本轮改动引入的 —— 但要明说结论已经不可信。
  if (noise != null && noise > baseline.frames.size * 0.1)
    console.log(
      `[判定] 警告:本底噪声已占总帧数的 ${((noise / baseline.frames.size) * 100).toFixed(1)}%,` +
        `这一档的「通过」几乎证明不了什么,请以 --css-only 那一档为准`,
    );
  const tolOf = (name) => (CSS_ONLY ? 0 : MODES[name].noise ? Infinity : TOL); // 噪声标尺自己不受容差约束,它就是标尺

  const rows = [];
  const notes = [];
  for (const { res, frames, cmp } of scans) {
    const isBase = res.name === baseline.name;
    // 帧数不对是比「哈希不一致」更严重的情况:少写的帧根本没有对手可比。
    // 跨组合比对兜不住单组合跑(--modes server1 没有比较对象),所以这里直接判死:
    //   - 脚本自报的帧数 ≠ 目录里的 PNG 数(并行最容易在这翻车:某个工作器悄悄少干一段)
    //   - PNG 数 ≠ 按 EFF_FPS × duration 算出来的应有帧数
    let countBad = false;
    if (res.code === 0) {
      if (res.result?.frames != null && res.result.frames !== frames.size) {
        console.error(`[${res.name}] 脚本报 ${res.result.frames} 帧,目录里只有 ${frames.size} 个 PNG`);
        countBad = true;
      }
      if (frames.size !== TOTAL_FRAMES) {
        console.error(`[${res.name}] 应有 ${TOTAL_FRAMES} 帧(fps ${FPS} × ${DURATION}s),实际 ${frames.size} 个 PNG`);
        countBad = true;
      }
    }
    // 并行度一条结论行都没打:说明跑的可能是还没实现并行的版本,这时候的「逐帧一致」
    // 证明不了「N 个工作器一致」,不能算通过。
    const workersBad = res.code === 0 && res.workersActual == null;
    if (workersBad) console.error(`[${res.name}] 日志里没有 workers 结论行,实际并行度未知`);
    // 显式请求 workers=4 却退到 1(export-frames 的「分不出合适的段」分支),这条组合
    // 一个工作器都没多开过,拿它证明不了 N=4 的等价性。以前只在表格里写个「4→1」就放行,
    // 等于给没跑过的用例盖章,所以这里直接判不通过。
    const downgraded =
      res.code === 0 &&
      typeof MODES[res.name].workers === "number" &&
      res.workersActual != null &&
      Number(res.workersActual) < MODES[res.name].workers;
    if (downgraded)
      notes.push(
        `[${res.name}] 请求 ${MODES[res.name].workers} 个工作器,实得 ${res.workersActual} —— ` +
          `这条组合退化成了 ${res.workersActual},不能拿它证明 N=${MODES[res.name].workers} 的等价性`,
      );
    // auto 退到 1 不算错(它本来就该按规模自己决定),但要在结论里点名:并行路径没被覆盖
    if (res.code === 0 && MODES[res.name].workers === "auto" && res.workersActual === "1")
      notes.push(`[${res.name}] 本次 auto 选了 1,并行路径未被这条组合覆盖`);

    const tol = tolOf(res.name);
    const overTol = !isBase && cmp.diff.length > tol;
    rows.push({
      name: res.name,
      frames: frames.size,
      ms: res.ms,
      workers: res.workersPick,
      diffCount:
        res.code !== 0 || !frames.size
          ? "失败"
          : isBase
            ? "—"
            : `${cmp.diff.length}${tol === Infinity ? "(标尺)" : `/容差 ${tol}`}`,
      diffHead: cmp.diff.slice(0, 10).join(", "),
      missing: cmp.missing,
      bad:
        res.code !== 0 || !frames.size || countBad || workersBad || downgraded || overTol ||
        cmp.missing.length > 0 || boundaryBad.has(res.name),
    });
  }

  console.log(`\n================ 逐帧比对(基线 = ${baseline.name})================`);
  const head = ["组合", "帧数", "耗时", "workers", "不一致帧数", "前 10 个不一致帧号"];
  const table = [head, ...rows.map((r) => [r.name, String(r.frames), fmtSec(r.ms), r.workers, r.diffCount, r.diffHead || "—"])];
  const widths = head.map((_, i) => Math.max(...table.map((row) => [...row[i]].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0))));
  const pad = (s, w) => {
    const vis = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
    return s + " ".repeat(Math.max(0, w - vis));
  };
  for (const [ri, row] of table.entries()) {
    console.log(row.map((c, i) => pad(c, widths[i])).join(" | "));
    if (ri === 0) console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  }

  // 缺帧和「哈希不一致」是两码事,混在一列里会把人引到错误的排查方向,所以单独列
  for (const r of rows) {
    if (!r.missing.length) continue;
    console.error(`\n[${r.name}] 有 ${r.missing.length} 帧只存在于一边(缺帧,不是画面差异):`);
    console.error(`  ${r.missing.slice(0, 20).join(", ")}${r.missing.length > 20 ? " …" : ""}`);
  }

  // 分段边界:并行有没有引入新偏差,看这一段而不是看总差异帧数
  if (boundaryRows.length) {
    console.log(`\n================ 分段边界检查(窗口 ${BOUNDARY_WIN} 帧)================`);
    console.log(`组合 / 工作器起点 s | 与基线在 [s, s+${BOUNDARY_WIN}) 的差异 | 同配置复跑同区间 | 从 s 起连续错`);
    for (const b of boundaryRows) {
      console.log(
        `  ${b.name} @${b.st} | ${b.cross} 帧 | ${b.rep == null ? "无复跑可参照" : b.rep + " 帧"} | ` +
          `${b.runLen} 帧${b.inNoise ? "(起点在本底噪声里,不作数)" : ""}${b.bad ? "   ✗ 边界块(快进与渲染路径不等价?)" : ""}`,
      );
    }
    if (!boundaryBad.size) console.log(`  → 所有分段边界都没有「从起点开始的连续差异块」`);
  } else if (MODE_NAMES.some((m) => MODES[m].workers !== 1)) {
    console.log(`\n[边界检查] 日志里没有分段行(本次没有真的并行),这一档未覆盖`);
  }

  // 自动缩放的决策日志单独打一遍:表格里只有结论,查问题要看它是怎么算出来的
  for (const res of runs) {
    if (!res.planLines.length) continue;
    console.log(`\n--- ${res.name} 的规划日志 ---`);
    for (const l of res.planLines) console.log(`  ${l.trim()}`);
  }

  for (const n of notes) console.log(`\n[覆盖度] ${n}`);

  if (rows.some((r) => r.bad)) {
    exitCode = 1;
    console.error(
      `\n【不通过】有组合超出容差 / 缺帧 / 帧数对不上 / 并行度退化 / 分段边界有连续差异块。中间目录:${OUT}`,
    );
    console.error(`保留现场重跑:node scripts/verify-export-modes.mjs --keep`);
  } else if (exitCode === 0) {
    // 全绿也要区分「严格一致」和「在噪声包络内」:后者证明不了逐帧确定,
    // 只证明「静态/并行没有比原版自己的抖动引入更多差异」。
    if (CSS_ONLY)
      console.log(
        `\n【通过·严格】css-only 子集下 ${runs.length} 种组合,第 ${CSS_ONLY_SKIP + 1} 帧起` +
          `逐帧 sha256 完全一致(共 ${rows[0].frames} 帧,判了 ${rows[0].frames - CSS_ONLY_SKIP} 帧)。`,
      );
    else if (noise == null)
      console.log(`\n【通过·严格】${runs.length} 种组合逐帧 sha256 完全一致,共 ${rows[0].frames} 帧(未跑噪声标尺)。`);
    else
      console.log(
        `\n【通过·噪声包络内】${runs.length} 种组合共 ${rows[0].frames} 帧,` +
          `各组合与基线的不一致帧数均 ≤ 容差 ${TOL}(本底噪声 ${noise})。\n` +
          `  注意:这不等于逐帧确定 —— 逐帧确定的证据要看 --css-only 那一档。`,
      );
    if (notes.length)
      console.log(`  上面的【覆盖度】提示说明有组合没走到预期的并行路径,读结论时要一并考虑。`);
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  exitCode = 1;
} finally {
  stopVite(vite);
  if (!KEEP) {
    // 一次跑下来几个 G(每种组合一整套 PNG),默认不留;要看帧就加 --keep
    fs.rmSync(OUT, { recursive: true, force: true });
    console.log(`已清理中间目录 ${OUT}(要保留请加 --keep)`);
  } else {
    console.log(`中间目录保留在 ${OUT}`);
  }
  process.exit(exitCode);
}
