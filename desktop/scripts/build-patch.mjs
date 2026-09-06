#!/usr/bin/env node
/**
 * 出补丁:把「构建产物」和「已装的 Overlay Studio」比一比,只把变化的文件打成一个小 EXE。
 *
 * 为什么要有这个?
 *   完整安装包 296MB,里面 840MB 是 Chrome 和 ffmpeg,而日常改动几乎全在 runtime/app(几十 KB 到几 MB)
 *   和壳 exe(11MB)。让已装的用户为了几个 JS 文件重下 300MB、卸了重装,不值得;
 *   开发时改一行想看效果也不该等 6 分钟的 NSIS 压缩。
 *
 * 用法(在 desktop/ 目录):
 *   node scripts/build-patch.mjs                    对着本机已装目录算差异,出补丁到 dist/patches/
 *   node scripts/build-patch.mjs --apply            出完直接静默装到本机已装目录,再逐文件核对
 *   node scripts/build-patch.mjs --apply --restart  装完顺手启动 Overlay Studio
 *   node scripts/build-patch.mjs --dry-run          只看差异,不出包
 *   node scripts/build-patch.mjs --release --base <清单.json> --save-manifest <文件>
 *                                                   发行模式:基线必须是上一版的清单文件,顺手存这版的清单
 *   node scripts/build-patch.mjs --install-dir <目录>       指定已装目录(测试副本用)
 *
 * 两种基线,行为不同(审查时踩过的坑,写清楚):
 *   - 目录(默认 = 本机已装目录):差异按目录里的真实文件算,适合本机开发自用。
 *     **不产生删除项** —— 目录里有、构建产物里没有的文件分不清是用户放的还是旧版残留,一律不碰。
 *   - 清单文件(--base x.json,发行用):上一版发过、这一版不发的文件才删,精确且不会误删用户的东西。
 *
 * 前提:已经跑过 npm run prepare-runtime(runtime/ 是新的)和 cargo/tauri build(壳 exe 是新的)。
 * 限制:Chrome、ffmpeg、Node 三样的版本变了不出补丁 —— 直接报错让你走完整安装包。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  manifestFromSource,
  manifestFromInstall,
  loadManifest,
  diffManifests,
  categoryOf,
  stripAbs,
  assertSafeRel,
  NEVER_DELETE,
} from "./patch-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const SRC_TAURI = path.join(DESKTOP, "src-tauri");
const RUNTIME_DIR = path.join(SRC_TAURI, "runtime");
const EXE_PATH = path.join(SRC_TAURI, "target", "release", "overlay-studio.exe");
const NODE_PATH = path.join(SRC_TAURI, "binaries", "node-x86_64-pc-windows-msvc.exe");
const ICON_PATH = path.join(SRC_TAURI, "icons", "icon.ico");
const TEMPLATE = path.join(DESKTOP, "patch", "patch.nsi.tmpl");
const DIST = path.join(DESKTOP, "dist");
const STAGE = path.join(DIST, "patch-stage");
const BUILD_DIR = path.join(DIST, "patch-build");
const OUT_DIR = path.join(DIST, "patches");
/** NSIS 安装器不认长路径,260 是硬天花板;留点余量 */
const MAX_PATH_BUDGET = 240;

// ---- 参数 ----
const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v == null || v.startsWith("--")) fail(`${name} 后面要跟一个值`);
  return v;
}
const flag = (name) => argv.includes(name);
const log = (s) => console.log(`[patch] ${s}`);
function fail(s) {
  console.error(`[patch] 失败:${s}`);
  process.exit(1);
}
const DRY = flag("--dry-run");
const APPLY = flag("--apply");
const RESTART = flag("--restart");
const RELEASE = flag("--release");
const baseArg = opt("--base");
const saveManifest = opt("--save-manifest");
const installDirArg = opt("--install-dir");

// ---- 已装目录:参数 > 注册表 InstallLocation > 默认位置 ----
function findInstallDir() {
  if (installDirArg) return path.resolve(installDirArg);
  const r = spawnSync(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overlay Studio", "/v", "InstallLocation"],
    { encoding: "utf8" },
  );
  const m = /InstallLocation\s+REG_SZ\s+(.+)$/m.exec(r.stdout || "");
  if (m) {
    const v = m[1].trim().replace(/^"|"$/g, "");
    if (v) return v;
  }
  return path.join(process.env.LOCALAPPDATA || "", "Overlay Studio");
}
/** 已装目录必须像一份真的 Overlay Studio,不然 --apply 会往随便什么目录里塞文件 */
function assertLooksInstalled(dir) {
  for (const rel of ["overlay-studio.exe", "node.exe", "runtime/VERSIONS.json", "runtime/app/package.json"]) {
    if (!fs.existsSync(path.join(dir, ...rel.split("/")))) fail(`${dir} 不像已装的 Overlay Studio(缺 ${rel})`);
  }
}

// ---- 当前构建产物 ----
if (!fs.existsSync(path.join(RUNTIME_DIR, "VERSIONS.json"))) fail(`没有 ${RUNTIME_DIR}\\VERSIONS.json,先跑 npm run prepare-runtime`);
if (!fs.existsSync(EXE_PATH)) fail(`没有 ${EXE_PATH}:先 cd src-tauri && cargo build --release(缺了它补丁会把用户机器上的 exe 当成已移除)`);
if (!fs.existsSync(NODE_PATH)) fail(`没有 ${NODE_PATH}:先跑 npm run prepare-runtime`);
log("给构建产物拍快照…");
let current;
try {
  current = manifestFromSource({ runtimeDir: RUNTIME_DIR, exePath: EXE_PATH, nodePath: NODE_PATH });
} catch (e) {
  fail(e.message);
}
log(`构建产物:${Object.keys(current.files).length} 个文件,id ${current.id.slice(0, 12)},app ${current.markers.app}`);
if (saveManifest) {
  const p = path.resolve(saveManifest);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(stripAbs(current), null, 2));
  log(`这版的清单已存到 ${p}(下一版补丁用它当 --base)`);
}

// ---- 基线 ----
const installDir = findInstallDir();
let base;
let baseIsManifest = false;
let baseDir = null;
if (RELEASE && !baseArg) fail("--release 必须配 --base <上一版清单.json>:发行补丁不能拿本机目录当基线");
if (baseArg) {
  const p = path.resolve(baseArg);
  if (!fs.existsSync(p)) fail(`基线不存在:${p}`);
  if (fs.statSync(p).isDirectory()) {
    if (RELEASE) fail("--release 模式的基线必须是清单文件,不能是目录");
    assertLooksInstalled(p);
    log(`给基线目录拍快照:${p}`);
    base = manifestFromInstall(p);
    baseDir = p;
  } else {
    try {
      base = loadManifest(p);
    } catch (e) {
      fail(e.message);
    }
    baseIsManifest = true;
    log(`基线清单:${p}(id ${base.id.slice(0, 12)})`);
  }
} else {
  assertLooksInstalled(installDir);
  log(`给已装目录拍快照:${installDir}`);
  base = manifestFromInstall(installDir);
  baseDir = installDir;
}
log(`基线:${Object.keys(base.files).length} 个文件,id ${base.id.slice(0, 12)},app ${base.markers.app}`);

// 补丁装到目标机器时核对的「基线 id」。
//  - 清单基线:就是清单的 id,目标机器的 patch-id.txt 必须等于它。
//  - 目录基线(本机自用):差异是对着目录真实文件算的,核对值取目录自己记录的 patch-id.txt;
//    没有就用算出来的 id(NSIS 那边改比 VERSIONS.json 的 builtAt)。
//    记录的 id 和实际内容对不上(手工拷过文件、上次装到一半)时,这个补丁只对这台机器成立,
//    不能拿去分发 —— 标出来。
let baseIdForCheck = base.id;
let devOnly = false;
if (baseDir) {
  const idFile = path.join(baseDir, "patch-id.txt");
  if (fs.existsSync(idFile)) {
    const recorded = fs.readFileSync(idFile, "utf8").trim();
    if (recorded && recorded !== base.id) {
      devOnly = true;
      log(`注意:${baseDir} 记录的 patch-id(${recorded.slice(0, 12)})和实际内容(${base.id.slice(0, 12)})不一致,` +
        `这个补丁只适用于这台机器,不要分发`);
    }
    baseIdForCheck = recorded || base.id;
  }
}

// ---- 差异 ----
const diff = diffManifests(base, current);
const hardMarkers = diff.markerDiff.filter((k) => k !== "app" && k !== "builtAt");
if (hardMarkers.length) {
  fail(
    `${hardMarkers.map((k) => `${k}: ${base.markers[k]} → ${current.markers[k]}`).join(";")} —— ` +
      `Chrome / ffmpeg / Node 变了不走补丁,请用完整安装包。`,
  );
}
// 删除项只从清单基线推导;目录基线里多出来的文件分不清是谁的,不碰
let deleted = baseIsManifest ? diff.deleted : [];
if (!baseIsManifest && diff.deleted.length) {
  log(`目录基线里有 ${diff.deleted.length} 个构建产物中不存在的文件,按规矩不删(可能是用户放的):`);
  for (const r of diff.deleted.slice(0, 8)) log(`    保留 ${r}`);
}
for (const r of deleted) {
  if (NEVER_DELETE.has(r)) fail(`删除列表里出现了 ${r},这不可能是对的,停下`);
  assertSafeRel(r);
}
// VERSIONS.json 每次构建 builtAt 都不同,不能拿它判断「有没有变化」;有别的变化时才顺带更新它
const VERSIONS_REL = "runtime/VERSIONS.json";
const realChanged = diff.changed.filter((r) => r !== VERSIONS_REL);
const payload = [...realChanged, ...diff.added];
if (!payload.length && !deleted.length) {
  log("已装的就是最新构建,没有需要打的补丁。");
  process.exit(0);
}
if (diff.changed.includes(VERSIONS_REL)) payload.push(VERSIONS_REL);

// 路径长度:安装目录 + 最长相对路径不能顶到 260
const longest = payload.reduce((m, r) => Math.max(m, r.length), 0);
if (installDir.length + 1 + longest > MAX_PATH_BUDGET) {
  log(`警告:已装目录很深(${installDir.length} 字符),加上最长文件路径 ${longest} 字符接近 Windows 260 上限,补丁可能写不进去`);
}

const byCat = {};
for (const rel of payload) byCat[categoryOf(rel)] = (byCat[categoryOf(rel)] || 0) + 1;
const bytes = payload.reduce((s, r) => s + current.files[r].size, 0);
const catNames = { app: "应用代码", dist: "静态构建", deps: "依赖", shell: "壳 exe", node: "Node" };
const summary = Object.entries(byCat).map(([k, n]) => `${catNames[k] || k} ${n}`).join("、") || "无";
log(`差异:更新 ${payload.length} 个文件(${summary},共 ${(bytes / 1048576).toFixed(1)}MB),删除 ${deleted.length} 个`);
for (const r of realChanged.slice(0, 15)) log(`  改 ${r}`);
for (const r of diff.added.slice(0, 15)) log(`  增 ${r}`);
for (const r of deleted.slice(0, 15)) log(`  删 ${r}`);
if (realChanged.length + diff.added.length + deleted.length > 45) log("  …(只列了前面几条)");
if (DRY) process.exit(0);
if (RELEASE && devOnly) fail("发行模式下基线记录和实际内容不一致,不能出包");

// ---- 暂存目录 ----
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const rel of payload) {
  const dst = path.join(STAGE, ...rel.split("/"));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(current.files[rel].abs, dst);
}
const builtAt = new Date();
const info = {
  from: baseIdForCheck,
  fromActual: base.id,
  to: current.id,
  app: current.markers.app,
  builtAt: builtAt.toISOString(),
  devOnly,
  updated: payload,
  deleted,
  categories: byCat,
};
fs.writeFileSync(path.join(STAGE, "patch-manifest.json"), JSON.stringify(stripAbs(current), null, 2));
fs.writeFileSync(path.join(STAGE, "patch-info.json"), JSON.stringify(info, null, 2));

// ---- 生成 NSIS 脚本 ----
const stamp = builtAt.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const tag = `${current.markers.app}-${stamp}-${baseIdForCheck.slice(0, 8)}-to-${current.id.slice(0, 8)}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `OverlayStudio-patch-${tag}${devOnly ? "-devonly" : ""}.exe`);
/** NSIS 字符串里 $ 是变量前缀,写成 $$ 才是字面 $ */
const nsisStr = (s) => String(s).replace(/\$/g, "$$$$");
const nsisRel = (p) => nsisStr(p.split("/").join("\\"));
const deleteLines = deleted.map((r) => `  Delete "$INSTDIR\\${nsisRel(r)}"`).join("\n");
const fill = {
  PATCH_TAG: tag,
  OUT_FILE: nsisStr(outFile),
  ICON: nsisStr(fs.existsSync(ICON_PATH) ? ICON_PATH : "${NSISDIR}\\Contrib\\Graphics\\Icons\\modern-install.ico"),
  APP_VERSION: current.markers.app,
  NEW_ID: current.id,
  NEW_ID_SHORT: current.id.slice(0, 8),
  BASE_ID: baseIdForCheck,
  BASE_ID_SHORT: baseIdForCheck.slice(0, 8),
  BASE_BUILT_AT: base.markers.builtAt || "",
  SUMMARY_TEXT: payload.length
    ? `本次更新 ${payload.length} 个文件(${summary})${deleted.length ? `,删除 ${deleted.length} 个` : ""}。`
    : `本次删除 ${deleted.length} 个已不再需要的文件。`,
  STAGE_DIR: nsisStr(STAGE),
  DELETE_LINES: deleteLines,
  DELETE_COUNT: String(deleted.length),
  FILE_COUNT: String(payload.length),
  BUILT_AT: info.builtAt,
};
let nsi = fs.readFileSync(TEMPLATE, "utf8");
// 先核对模板里的占位符都认识,再替换 —— 替换后再查会被文件名里碰巧出现的 @XXX@ 误伤
for (const m of nsi.matchAll(/@([A-Z_]+)@/g)) {
  if (!(m[1] in fill)) fail(`模板里有不认识的占位符:@${m[1]}@`);
}
for (const [k, v] of Object.entries(fill)) nsi = nsi.split(`@${k}@`).join(v);
const nsiFile = path.join(BUILD_DIR, "patch.nsi");
// makensis 靠 BOM 识别 UTF-8:没有 BOM 会按本地代码页读,脚本里的中文直接报「Bad text encoding」
fs.writeFileSync(nsiFile, "\uFEFF" + nsi);

// ---- makensis ----
const candidates = [path.join(process.env.LOCALAPPDATA || "", "tauri", "NSIS", "makensis.exe"), "makensis"];
const makensis = candidates.find((c) => c === "makensis" || fs.existsSync(c));
log(`makensis:${makensis}`);
const r = spawnSync(makensis, ["/V2", nsiFile], { encoding: "utf8" });
if (r.error) fail(`跑不起 makensis:${r.error.message}(Tauri CLI 会把它装在 %LOCALAPPDATA%\\tauri\\NSIS,先 npx tauri build 一次)`);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  fail(`makensis 退出码 ${r.status}(脚本在 ${nsiFile})`);
}
const size = fs.statSync(outFile).size;
log(`补丁已生成:${outFile}(${(size / 1048576).toFixed(1)}MB)`);
log(`基线 ${baseIdForCheck.slice(0, 12)} → 目标 ${current.id.slice(0, 12)}${devOnly ? "(仅本机)" : ""}`);

// ---- --apply:静默装到已装目录,再逐文件核对 ----
if (APPLY) {
  assertLooksInstalled(installDir);
  log(`静默应用到 ${installDir} …`);
  // /D= 必须是最后一个参数且不能加引号(NSIS 规矩):经 cmd.exe 原样转交,不让 Node 加引号
  const cmd = `"${outFile}" /S${RESTART ? " /RESTART" : ""} /D=${installDir}`;
  const a = spawnSync(cmd, { shell: true, windowsVerbatimArguments: true, encoding: "utf8", stdio: "inherit" });
  const codes = { 3: "没找到已装的 Overlay Studio", 4: "基线不匹配", 5: "有文件写不进去(被占用?)" };
  if (a.status !== 0) fail(`补丁退出码 ${a.status}${codes[a.status] ? `:${codes[a.status]}` : ""}${a.error ? " " + a.error.message : ""}`);
  const after = manifestFromInstall(installDir);
  const bad = [];
  // 不只核对这次送过去的文件:构建产物里的每一个文件都得在已装目录里、哈希一致,
  // 没送的那些也一样(它们理应本来就对)。用户自己放进去的多余文件不算错。
  for (const rel of Object.keys(current.files)) {
    const f = after.files[rel];
    if (!f || f.sha256 !== current.files[rel].sha256) bad.push(`${payload.includes(rel) ? "写入后不一致" : "本该没变却不一致"} ${rel}`);
  }
  for (const rel of deleted) if (after.files[rel]) bad.push(`没删掉 ${rel}`);
  const idFile = path.join(installDir, "patch-id.txt");
  const idOnDisk = fs.existsSync(idFile) ? fs.readFileSync(idFile, "utf8").trim() : "";
  if (idOnDisk !== current.id) bad.push(`patch-id.txt=${idOnDisk.slice(0, 12)} 不是 ${current.id.slice(0, 12)}`);
  if (bad.length) {
    for (const b of bad) console.error(`[patch]   ${b}`);
    fail(`应用后核对失败(${bad.length} 项)`);
  }
  log(`应用后核对通过:${payload.length} 个文件哈希一致,${deleted.length} 个已删除,patch-id 已更新。`);
}
