#!/usr/bin/env node
/**
 * 一条命令跑完整套集成验收(DESIGN.md 任务 E 第 2 步)。
 *
 * 用法:
 *   node scripts/smoke-all.mjs                 # 验收 src-tauri/target/release 里的 exe
 *   node scripts/smoke-all.mjs <exe 绝对路径>   # 验收装出来的那份(第 3 步用)
 *   加 --skip-export 只跑启动和退出两项(装出来那份的最小验证够用了,
 *   导出链路和 release exe 跑的是同一份 runtime,已经验过一次)
 *
 * 为什么要合成一个脚本:被测程序必须在「启动 → 冒烟 → 导出 → 退出」全程活着。
 * 分成几条命令跑的话,启动它的那条命令一结束,调用方的进程组回收就会把它一起带走。
 * 这里让被测 exe 当本脚本的子进程,活到最后一步。
 *
 * 依次:启动 exe → smoke-boot.mjs → smoke-export.mjs → smoke-shutdown.mjs。
 * 任何一步不过就以退出码 1 退出,并保证被测进程被收掉。
 */
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_EXE = path.join(ROOT, "src-tauri", "target", "release", "overlay-studio.exe");
const args = process.argv.slice(2);
const SKIP_EXPORT = args.includes("--skip-export");
const exeArg = args.find((a) => !a.startsWith("--"));
const EXE = exeArg ? path.resolve(exeArg) : DEFAULT_EXE;

const log = (...a) => console.log("\n[all]", ...a);

if (!fs.existsSync(EXE)) {
  console.error("[all] FAIL: 找不到 exe: " + EXE);
  process.exit(1);
}

log("被测 exe:", EXE, `(${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB)`);

let app = null;
function killApp() {
  if (!app || app.killed) return;
  try {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(app.pid)], { stdio: "ignore" });
  } catch {
    /* 已经退了 */
  }
}
process.on("exit", killApp);
process.on("SIGINT", () => {
  killApp();
  process.exit(130);
});

log("启动被测程序…");
app = spawn(EXE, [], { stdio: "ignore", windowsHide: false });
app.on("error", (e) => {
  console.error("[all] FAIL: 启动失败 " + e.message);
  process.exit(1);
});

/** 跑一个子步骤脚本,stdio 直通,返回退出码 */
function step(name, script, args = []) {
  log(`===== ${name} =====`);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    stdio: "inherit",
    cwd: ROOT,
  });
  const code = r.status ?? 1;
  log(`===== ${name} 结束, 退出码 ${code} =====`);
  return code;
}

const exeName = path.basename(EXE);

let code = step("1/3 启动冒烟", "smoke-boot.mjs", [exeName]);
if (code !== 0) {
  log("启动冒烟失败,收掉被测程序后退出");
  killApp();
  process.exit(1);
}

let exportOk = true;
if (SKIP_EXPORT) {
  log("===== 2/3 导出冒烟 已按 --skip-export 跳过 =====");
} else {
  code = step("2/3 导出冒烟", "smoke-export.mjs");
  exportOk = code === 0;
  if (!exportOk) log("导出冒烟失败,仍然继续做退出检查,好把两边的结论都拿到");
}

// 退出检查自己会 taskkill 主程序
const shutdownCode = step("3/3 退出检查", "smoke-shutdown.mjs");
killApp();

console.log("");
console.log(
  "ALL_RESULT_JSON " +
    JSON.stringify({
      exe: EXE,
      boot: true,
      export: SKIP_EXPORT ? "skipped" : exportOk,
      shutdown: shutdownCode === 0,
    }),
);

if (!exportOk || shutdownCode !== 0) {
  console.error("[all] FAIL: 有步骤没通过,细节看上面");
  process.exit(1);
}
console.log("[all] PASS: 启动 / 导出 / 退出 三项全过");
