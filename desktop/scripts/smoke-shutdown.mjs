#!/usr/bin/env node
/**
 * 退出冒烟(DESIGN.md 任务 E 第 2 步最后一条 + 契约第 8 条)。
 *
 * 用法: node scripts/smoke-shutdown.mjs
 * 前提: 先跑过 smoke-boot.mjs,.smoke-state.json 里有主程序 PID。
 *
 * 关主程序前先把它整棵后代树记下来(导出跑过之后,node 底下还挂着 Chrome),
 * 关完等 5 秒,确认这棵树上的进程一个不剩。
 * 只认后代,不按映像名数:机器上别的 node.exe / chrome.exe 与本次无关。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { procList, findByName, descendants } from "./smoke-procs.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE = path.join(ROOT, ".smoke-state.json");

const log = (...a) => console.log("[shutdown]", ...a);
function fail(msg) {
  console.error("[shutdown] FAIL:", msg);
  process.exit(1);
}

if (!fs.existsSync(STATE)) fail("没有 .smoke-state.json,先跑 scripts/smoke-boot.mjs");
const state = JSON.parse(fs.readFileSync(STATE, "utf8"));

// ---- 关之前:记下整棵树 ----
const before = procList();
const mains = findByName(state.exe, before).filter((p) => state.mainPids.includes(p.pid));
if (!mains.length) log(`注意: ${state.exe} 已经不在进程列表里了(可能已被关闭)`);
const mainPids = mains.map((p) => p.pid);
const tree = descendants(mainPids, before);
const byName = {};
for (const p of tree) byName[p.name] = (byName[p.name] ?? 0) + 1;
log(`关闭前主程序 PID: ${mainPids.join(", ") || "(无)"}`);
log(`关闭前后代进程 ${tree.length} 个: ${Object.entries(byName).map(([n, c]) => `${n}×${c}`).join(", ") || "(无)"}`);
const watch = [...mainPids, ...tree.map((p) => p.pid)];

// ---- 关闭 ----
for (const pid of mainPids) {
  log(`taskkill /F /T /PID ${pid}`);
  try {
    const out = execSync(`taskkill /F /T /PID ${pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    log(`  终止了 ${out.trim().split(/\r?\n/).length} 个进程`);
  } catch (e) {
    log("  taskkill 报错(可能进程已退出): " + String(e.message).trim().slice(0, 200));
  }
}

log("等 5 秒…");
await new Promise((r) => setTimeout(r, 5000));

// ---- 残留检查 ----
const after = procList();
const alivePids = new Set(after.map((p) => p.pid));
const leftover = watch.filter((p) => alivePids.has(p)).map((pid) => {
  const p = after.find((x) => x.pid === pid);
  return { pid, name: p?.name };
});
const leftoverNodes = leftover.filter((p) => p.name?.toLowerCase() === "node.exe");
const leftoverChromes = leftover.filter((p) => p.name?.toLowerCase() === "chrome.exe");

log(`关闭后本次进程树残留: ${leftover.length ? leftover.map((p) => `${p.name}(${p.pid})`).join(", ") : "(无)"}`);
log(
  `参考: 机器上还有 ${findByName("node.exe", after).length} 个 node.exe、` +
    `${findByName("chrome.exe", after).length} 个 chrome.exe,都与本次启动无关(用户自己的浏览器等)`,
);

const clean = leftover.length === 0;
console.log("");
console.log(
  "SHUTDOWN_RESULT_JSON " +
    JSON.stringify({
      ok: clean,
      killedMain: mainPids,
      treeSizeBeforeKill: tree.length,
      leftover,
      leftoverNodes: leftoverNodes.map((p) => p.pid),
      leftoverChromes: leftoverChromes.map((p) => p.pid),
    }),
);

if (!clean) fail("有本次启动的进程残留,契约第 8 条(taskkill /F /T)没有完全生效");
log("PASS: 主程序及其全部后代(node.exe / chrome.exe)都已收干净");
