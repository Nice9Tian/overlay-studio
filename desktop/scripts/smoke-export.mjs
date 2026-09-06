#!/usr/bin/env node
/**
 * 集成验收用的导出冒烟脚本(DESIGN.md 任务 E 第 2 步)。
 *
 * 用法: node scripts/smoke-export.mjs
 * 前提: Overlay Studio 已经在跑,http://127.0.0.1:5177 能访问。
 *
 * 依次做四件事,任何一步不过就以退出码 1 退出:
 *   1. GET /                 —— 确认首页是编辑台(HTML 里有 Overlay Studio)
 *   2. POST /api/export      —— 用 public/demo/demo-overlay.json 跑一次完整导出
 *   3. GET /api/export-status—— 每 5 秒轮询进度,直到 running=false
 *   4. 查成品目录            —— %USERPROFILE%\Videos\Overlay Studio\output 下要有本次新增的 .mov
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = "http://127.0.0.1:5177";
const ROOT = path.resolve(import.meta.dirname, "..");
const DEMO = path.join(ROOT, "src-tauri", "runtime", "app", "public", "demo", "demo-overlay.json");
const EXPORT_ROOT = path.join(os.homedir(), "Videos", "Overlay Studio");
const OUT_DIR = path.join(EXPORT_ROOT, "output");
const HARD_CAP_MS = 25 * 60_000;

const log = (...a) => console.log("[smoke]", ...a);
const mb = (n) => (n / 1024 / 1024).toFixed(1);

function listMovs() {
  if (!fs.existsSync(OUT_DIR)) return new Map();
  const m = new Map();
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/\.(mov|webm)$/i.test(f)) continue;
    const p = path.join(OUT_DIR, f);
    m.set(f, fs.statSync(p).size);
  }
  return m;
}

function fail(msg) {
  console.error("[smoke] FAIL:", msg);
  process.exit(1);
}

// ---- 1. 首页 ----
log("GET", BASE);
let html;
try {
  const r = await fetch(BASE + "/", { cache: "no-store" });
  html = await r.text();
  log("  status", r.status, "bytes", html.length);
} catch (e) {
  fail("首页请求失败: " + e.message);
}
if (!html.includes("Overlay Studio")) fail("首页 HTML 里没有 Overlay Studio,拿到的可能不是编辑台");
log("  OK: 首页含 Overlay Studio");

// ---- 2. 组 job ----
if (!fs.existsSync(DEMO)) fail("找不到 demo overlay: " + DEMO);
const doc = JSON.parse(fs.readFileSync(DEMO, "utf8"));
const duration = Math.max(...doc.cards.map((c) => c.end)) + 0.5;
const body = { mode: "timeline", doc, scale: 1, speed: 1, fps: 29.97, duration };
log(`导出 job: ${doc.cards.length} 张卡, duration=${duration}s, fps=29.97`);

const before = listMovs();
log("导出前 output/ 里已有", before.size, "个成品文件");

// ---- 3. 触发导出 + 轮询 ----
const t0 = Date.now();
// POST 是长请求:服务端要等子进程跑完才 res.end,所以不 await,先挂着,同时轮询进度
const postPromise = fetch(BASE + "/api/export", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, text: await r.text() }));

let settled = null;
postPromise.then((v) => (settled = v)).catch((e) => (settled = { status: 0, text: String(e) }));

log("已 POST /api/export,开始轮询 /api/export-status");
let lastLine = "";
for (;;) {
  if (Date.now() - t0 > HARD_CAP_MS) fail("超过 25 分钟仍未结束,放弃");
  await new Promise((r) => setTimeout(r, 5000));
  let prog;
  try {
    const r = await fetch(BASE + "/api/export-status", { cache: "no-store" });
    prog = await r.json();
  } catch (e) {
    log("  (状态查询失败,继续等)", e.message);
    continue;
  }
  const line = `  ${((Date.now() - t0) / 1000).toFixed(0)}s stage=${prog.stage} frame=${prog.frame}/${prog.total} running=${prog.running}`;
  if (line !== lastLine) {
    console.log(line);
    lastLine = line;
  }
  // running 变回 false 就是结束了(prog 初值 running=false,所以要等它先变 true 或等 POST 返回)
  if (settled) break;
  if (prog.running === false && Date.now() - t0 > 15000 && prog.stage === "done" && prog.ok !== undefined) break;
}

const res = settled ?? (await postPromise);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
log(`导出请求返回 status=${res.status},耗时 ${elapsed}s`);
let data = null;
try {
  data = JSON.parse(res.text);
} catch {
  fail("导出返回的不是 JSON(前 500 字): " + res.text.slice(0, 500));
}
if (!data.ok) fail("导出报告失败: " + String(data.error).slice(0, 1200));
log("  MOV:", data.mov ?? "(无)");
log("  WebM:", data.webm ?? "(无)");
log("  帧数:", data.frames, "@", data.fps, "fps");
log("  目录:", data.dir);

// ---- 4. 成品落盘 ----
const after = listMovs();
const fresh = [...after.keys()].filter((k) => !before.has(k) || before.get(k) !== after.get(k));
if (!fresh.length) fail("output/ 里没有出现新的成品文件: " + OUT_DIR);
const movs = fresh.filter((f) => f.toLowerCase().endsWith(".mov"));
if (!movs.length) fail("有新文件但没有 .mov: " + fresh.join(", "));
log("本次新增成品:");
for (const f of fresh) log(`  ${f}  ${mb(after.get(f))} MB`);

console.log("");
console.log("SMOKE_RESULT_JSON " + JSON.stringify({
  ok: true,
  elapsedSec: Number(elapsed),
  frames: data.frames,
  fps: data.fps,
  outDir: OUT_DIR,
  files: fresh.map((f) => ({ name: f, sizeMB: Number(mb(after.get(f))) })),
}));
log("PASS");
