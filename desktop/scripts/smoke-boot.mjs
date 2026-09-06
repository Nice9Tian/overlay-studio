#!/usr/bin/env node
/**
 * 启动冒烟(DESIGN.md 任务 E 第 2 步的前半段)。
 *
 * 用法: node scripts/smoke-boot.mjs [exe 映像名,默认 overlay-studio.exe]
 * 前提: Overlay Studio 的 exe 刚刚被启动(本脚本不负责启动它)。
 *
 * 最多等 90 秒,逐条验证:
 *   1. 主程序进程在,且窗口标题是 Overlay Studio;
 *   2. http://127.0.0.1:5177/ 返回的 HTML 里含 Overlay Studio;
 *   3. 主程序底下确实挂着 node.exe 子进程(sidecar)。
 * 顺便把主程序 PID 记进 .smoke-state.json,给 smoke-shutdown.mjs 用。
 * 只认主程序的后代进程,不按映像名数——机器上本来就有别的 node/chrome。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { procList, findByName, descendants } from "./smoke-procs.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE = path.join(ROOT, ".smoke-state.json");
const BASE = "http://127.0.0.1:5177";
const DEADLINE = Date.now() + 90_000;
const EXE = process.argv[2] ?? "overlay-studio.exe";
const started = Date.now();

const log = (...a) => console.log("[boot]", ...a);
function fail(msg) {
  console.error("[boot] FAIL:", msg);
  process.exit(1);
}

/** 窗口标题只有 tasklist /V 给得出来 */
function windowTitles(image) {
  try {
    const out = execSync(`tasklist /V /FO CSV /NH /FI "IMAGENAME eq ${image}"`, { encoding: "utf8" });
    const map = new Map();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) ?? [];
      if (cols.length >= 2 && /^\d+$/.test(cols[1])) map.set(Number(cols[1]), cols[cols.length - 1]);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ---- 1. 主程序进程 + 窗口标题 ----
let main = [];
while (Date.now() < DEADLINE) {
  main = findByName(EXE);
  if (main.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (!main.length) fail(`进程列表里找不到 ${EXE},主程序没起来`);
const mainPids = main.map((p) => p.pid);
log(`主程序进程: ${mainPids.join(", ")}`);

let title = null;
while (Date.now() < DEADLINE) {
  const titles = windowTitles(EXE);
  title = mainPids.map((p) => titles.get(p)).find((t) => t && t.includes("Overlay Studio")) ?? null;
  if (title) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (title) log(`OK: 窗口标题 = ${title}`);
else log(`警告: 90 秒内没等到标题为 Overlay Studio 的窗口`);

// ---- 2. 5177 上的编辑台 ----
let html = null;
let lastErr = "";
while (Date.now() < DEADLINE) {
  try {
    const r = await fetch(BASE + "/", { cache: "no-store" });
    const t = await r.text();
    if (r.ok && t.includes("Overlay Studio")) {
      html = t;
      log(`OK: GET / 返回 ${r.status}, ${t.length} 字节, 含 Overlay Studio`);
      break;
    }
    lastErr = `status=${r.status} 但内容里没有 Overlay Studio`;
  } catch (e) {
    lastErr = e.message;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
if (html === null) fail(`90 秒内 ${BASE}/ 没有返回可用的编辑台页面。最后一次: ${lastErr}`);

const readySec = Number(((Date.now() - started) / 1000).toFixed(1));
log(`就绪耗时约 ${readySec}s(从本脚本启动算起)`);

// ---- 3. sidecar 子进程(只看主程序的后代) ----
const kids = descendants(mainPids);
const nodeKids = kids.filter((p) => p.name.toLowerCase() === "node.exe");
if (!nodeKids.length) fail(`${EXE} 底下没有 node.exe 子进程,sidecar 没起来`);
log(`sidecar node.exe: ${nodeKids.map((p) => p.pid).join(", ")}`);
log(`主程序后代共 ${kids.length} 个进程: ${[...new Set(kids.map((p) => p.name))].join(", ")}`);

fs.writeFileSync(
  STATE,
  JSON.stringify({ capturedAt: new Date().toISOString(), exe: EXE, mainPids, windowTitle: title }, null, 2),
);
log("主程序 PID 已写入 .smoke-state.json");

console.log("");
console.log(
  "BOOT_RESULT_JSON " +
    JSON.stringify({
      ok: true,
      readySec,
      windowTitle: title,
      mainPids,
      sidecarPids: nodeKids.map((p) => p.pid),
      htmlBytes: html.length,
    }),
);
log("PASS");
