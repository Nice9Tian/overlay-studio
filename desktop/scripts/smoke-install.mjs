#!/usr/bin/env node
/**
 * 安装包最小验证(DESIGN.md 任务 E 第 3 步)。
 *
 * 用法: node scripts/smoke-install.mjs [安装包路径]
 * 不给路径就自动取 src-tauri/target/release/bundle/nsis/ 里最新的 *-setup.exe。
 *
 * 静默装到 %TEMP%\ovs-install-test → 从那儿启动跑 smoke-all(跳过导出)→ 静默卸载 →
 * 看目录清没清干净。全程不碰真正的安装位置,也不动开始菜单/桌面快捷方式之外的东西。
 *
 * 注意 NSIS 的规矩:/D= 必须是最后一个参数,值不能加引号。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NSIS_DIR = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
const TARGET = path.join(os.tmpdir(), "ovs-install-test");

const log = (...a) => console.log("\n[install]", ...a);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
function fail(msg) {
  console.error("[install] FAIL:", msg);
  process.exit(1);
}

// ---- 找安装包 ----
let installer = process.argv[2];
if (!installer) {
  if (!fs.existsSync(NSIS_DIR)) fail("找不到 " + NSIS_DIR);
  const cands = fs
    .readdirSync(NSIS_DIR)
    .filter((f) => f.toLowerCase().endsWith("-setup.exe"))
    .map((f) => ({ f, p: path.join(NSIS_DIR, f), t: fs.statSync(path.join(NSIS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!cands.length) fail("nsis 目录里没有 *-setup.exe");
  installer = cands[0].p;
}
installer = path.resolve(installer);
if (!fs.existsSync(installer)) fail("安装包不存在: " + installer);
log(`安装包: ${installer}  ${mb(fs.statSync(installer).size)} MB`);

// ---- 先清掉上一次的测试目录 ----
if (fs.existsSync(TARGET)) {
  log("清掉上一次的测试安装目录 " + TARGET);
  fs.rmSync(TARGET, { recursive: true, force: true });
}

// ---- 静默安装 ----
log(`静默安装到 ${TARGET} …`);
const t0 = Date.now();
const inst = spawnSync(installer, ["/S", `/D=${TARGET}`], { stdio: "inherit" });
if (inst.error) fail("安装器起不来: " + inst.error.message);
log(`安装器退出码 ${inst.status}`);

// NSIS /S 会立刻返回,真正的解压在后台继续,所以要等文件落地。
// 光看某个目录在不在是不够的:node_modules 很早就出现了,而 chrome / ffmpeg 还在写。
// 踩过的坑:装到一半就启动,sidecar 的 node.exe 还没写完,程序弹了个「无法启动内置 Node」
// 的模态框——窗口标题是对的,5177 却永远起不来,看起来像程序有 bug,其实是验收脚本抢跑。
// 所以三个条件都要满足:关键文件齐、目录大小连续两次不再变、再多稳一会儿。
const MUST_EXIST = [
  "overlay-studio.exe",
  "node.exe",
  "uninstall.exe",
  path.join("runtime", "ffmpeg", "ffmpeg.exe"),
  path.join("runtime", "ffmpeg", "ffprobe.exe"),
  path.join("runtime", "app", "node_modules", "vite", "bin", "vite.js"),
  path.join("runtime", "VERSIONS.json"),
];
function chromeExeExists() {
  const base = path.join(TARGET, "runtime", "chrome", "chrome");
  if (!fs.existsSync(base)) return false;
  return fs
    .readdirSync(base)
    .some((v) => fs.existsSync(path.join(base, v, "chrome-win64", "chrome.exe")));
}
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    try {
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch {
      /* 忽略读不到的 */
    }
  }
  return total;
}

const deadline = Date.now() + 10 * 60_000;
let appExe = null;
let lastSize = -1;
let stableRounds = 0;
while (Date.now() < deadline) {
  if (fs.existsSync(TARGET)) {
    // 安装目录里有三个 exe:主程序、sidecar 的 node.exe、卸载程序。
    // 早期版本取「第一个不叫 uninstall 的 exe」,结果 readdir 先给出 node.exe,
    // 于是启动的是没带参数的 node —— 它转瞬即逝,5177 上什么都没有,报成启动失败。
    const exes = fs
      .readdirSync(TARGET)
      .filter((f) => f.toLowerCase().endsWith(".exe"))
      .filter((f) => !/^uninstall/i.test(f) && f.toLowerCase() !== "node.exe");
    const hit = exes.find((f) => /overlay/i.test(f)) ?? exes[0];
    const allThere = MUST_EXIST.every((r) => fs.existsSync(path.join(TARGET, r))) && chromeExeExists();
    if (hit && allThere) {
      const size = dirSize(TARGET);
      stableRounds = size === lastSize ? stableRounds + 1 : 0;
      lastSize = size;
      // 连续两轮(共 6 秒)大小不变才认为解压真的结束了
      if (stableRounds >= 2) {
        appExe = path.join(TARGET, hit);
        break;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!appExe) fail(`10 分钟内 ${TARGET} 里没等到装完(exe + runtime)`);
const installSec = ((Date.now() - t0) / 1000).toFixed(0);

const installedMB = Number(mb(dirSize(TARGET)));
log(`安装完成,耗时约 ${installSec}s,装出来 ${installedMB} MB`);
log(`主程序: ${appExe}`);
log(`安装目录顶层: ${fs.readdirSync(TARGET).join(", ")}`);

// ---- 跑启动/退出冒烟 ----
log("对装出来的这份跑 smoke-all(跳过导出)…");
const smoke = spawnSync(process.execPath, [path.join(ROOT, "scripts", "smoke-all.mjs"), appExe, "--skip-export"], {
  stdio: "inherit",
  cwd: ROOT,
});
const smokeOk = smoke.status === 0;
log(`冒烟退出码 ${smoke.status}`);

// ---- 静默卸载 ----
const uninstaller = fs
  .readdirSync(TARGET)
  .map((f) => path.join(TARGET, f))
  .find((p) => /uninstall.*\.exe$/i.test(path.basename(p)));
let uninstalled = false;
let leftovers = [];
if (!uninstaller) {
  log("警告: 安装目录里没找到卸载程序");
} else {
  log(`静默卸载: ${uninstaller}`);
  const un = spawnSync(uninstaller, ["/S"], { stdio: "inherit" });
  log(`卸载器退出码 ${un.status}`);
  const undeadline = Date.now() + 5 * 60_000;
  while (Date.now() < undeadline) {
    if (!fs.existsSync(TARGET) || fs.readdirSync(TARGET).length === 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!fs.existsSync(TARGET)) {
    uninstalled = true;
    log("卸载后目录已完全移除");
  } else {
    leftovers = fs.readdirSync(TARGET);
    uninstalled = leftovers.length === 0;
    log(`卸载后目录还剩 ${leftovers.length} 项: ${leftovers.slice(0, 20).join(", ") || "(空)"}`);
    if (uninstalled) fs.rmSync(TARGET, { recursive: true, force: true });
  }
}

console.log("");
console.log(
  "INSTALL_RESULT_JSON " +
    JSON.stringify({
      installer,
      installerMB: Number(mb(fs.statSync(installer).size)),
      installSec: Number(installSec),
      installedMB,
      appExe,
      smokeOk,
      uninstallClean: uninstalled,
      leftovers,
    }),
);

if (!smokeOk) fail("装出来的那份没能通过启动/退出冒烟");
console.log("[install] PASS: 装得上、跑得起来、卸得掉");
