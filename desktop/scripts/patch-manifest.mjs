/**
 * 补丁清单:给「一份 Overlay Studio 安装」拍一张指纹快照。
 *
 * 两种来源拍出来的快照结构完全一样,才能互相 diff:
 *   - 构建产物(source):desktop/src-tauri/runtime/** + target/release/overlay-studio.exe + binaries/node-*.exe
 *   - 已装目录(install):%LOCALAPPDATA%\Overlay Studio 这种真实安装目录
 * 路径一律换算成「安装目录里的相对路径」(runtime/app/…、overlay-studio.exe、node.exe),
 * 这样 build-patch 拿两份清单一比,就知道该往用户机器上送哪些文件。
 *
 * 为什么 chrome / ffmpeg 不逐文件哈希?
 *   两者加起来 840MB、上千个文件,哈希一次十几秒,而它们几乎不变;变了(换 Chrome 版本)
 *   也不该走补丁 —— 那是完整安装包的事。所以只记 VERSIONS.json 里的版本字符串当「标记」,
 *   标记不一致就拒绝出补丁。
 *
 * 为什么 node_modules 要逐文件哈希?
 *   依赖偶尔会变(升级 vite / puppeteer),变的往往只是几十个文件;逐文件比对能让补丁只带
 *   变化的那部分,而不是整个 136MB。6000 多个文件哈希约 2 秒,可以接受。
 *
 * 用户数据永远不进清单(不送、不删):字体、导入的素材、录屏、视频抽帧缓存、导出目录、
 * 个人 lint 阈值、Vite 缓存。漏一条就等于下一个补丁会把用户的东西删掉(2026-09-06 审查时
 * 真的删过测试床里的录屏),所以这个列表宁多勿少。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** 安装目录里这些相对路径前缀属于用户数据或运行期缓存,清单不碰 */
const EXCLUDE_PREFIXES = [
  "runtime/app/node_modules/.vite/",
  "runtime/app/node_modules/.vite-temp/",
  "runtime/app/public/_media/", // 导入的视频素材
  "runtime/app/public/_fxframes/", // 视频抽帧缓存
  "runtime/app/public/demo/", // /api/upload-demo 把用户录屏存在这里(vite.config.ts 的 demoUpload 插件)
  "runtime/app/exports/",
  "runtime/app/src/assets/fonts/", // 用户自己放的字体
  "runtime/app/public/sfx/", // 用户自己放的音效
  "runtime/chrome/",
  "runtime/ffmpeg/",
];
/** 例外:随包发的说明和示例,放行 */
const EXCLUDE_EXCEPT = new Set([
  "runtime/app/src/assets/fonts/README.md",
  "runtime/app/public/sfx/README.md",
  "runtime/app/public/demo/README.txt",
  "runtime/app/public/demo/demo-overlay.json",
  "runtime/app/public/demo/demo.srt",
]);
/** 单个文件:安装器/补丁自己的记录,以及用户的个人配置 */
const EXCLUDE_FILES = new Set([
  "uninstall.exe",
  "patch-id.txt",
  "patch-manifest.json",
  "patch-info.json",
  "patch-log.txt",
  "runtime/app/lint-rules.local.json", // 用户个人的 lint 阈值(上游 .gitignore 里专门列的)
]);

/** 这些文件永远不允许出现在补丁的删除列表里:少了它们程序就起不来 */
export const NEVER_DELETE = new Set(["overlay-studio.exe", "node.exe", "runtime/VERSIONS.json", "uninstall.exe"]);

export function isExcluded(rel) {
  if (EXCLUDE_FILES.has(rel)) return true;
  if (EXCLUDE_EXCEPT.has(rel)) return false;
  return EXCLUDE_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * 相对路径合法性:补丁会把它拼到 $INSTDIR 后面写文件、删文件,所以这里必须卡死。
 * 清单是 JSON,会被归档、跨机拷贝,不能假设它永远是我们自己生成的。
 */
export function assertSafeRel(rel) {
  const bad =
    !rel ||
    rel.startsWith("/") ||
    rel.startsWith("\\") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "") ||
    /[*?"<>|:\\]/.test(rel) ||
    /[\x00-\x1f]/.test(rel);
  if (bad) throw new Error(`清单里有不合法的相对路径:${JSON.stringify(rel)}`);
  return rel;
}

/** 相对路径统一用正斜杠,和平台无关 */
function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** 分块哈希:node.exe 88MB、原生模块十几 MB,整个 readFileSync 进内存没必要 */
function sha256File(abs) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** 递归收集 root 下所有文件,prefix 是它们在安装目录里的相对路径前缀("" 或 "runtime") */
function collect(root, prefix, files) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        // 静默跳过等于清单悄悄漏文件,以后永远补不上;明确报出来
        throw new Error(`清单不支持符号链接/junction:${abs}`);
      }
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = (prefix ? prefix + "/" : "") + toRel(root, abs);
      if (isExcluded(rel)) continue;
      assertSafeRel(rel);
      const st = fs.statSync(abs);
      files[rel] = { sha256: sha256File(abs), size: st.size, abs };
    }
  }
}

function readMarkers(versionsPath) {
  try {
    const v = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
    // builtAt 是完整安装包那次构建的时间戳,每次构建都不同 —— 没打过补丁的原版安装靠它认身份
    return { chrome: v.chrome ?? "", ffmpeg: v.ffmpeg ?? "", node: v.node ?? "", app: v.app ?? "", builtAt: v.builtAt ?? "" };
  } catch {
    return { chrome: "", ffmpeg: "", node: "", app: "", builtAt: "" };
  }
}

/** 清单 id:文件相对路径 + 哈希按路径排序拼起来再哈希;两份内容一样的安装,id 一定一样 */
function manifestId(files, markers) {
  const h = crypto.createHash("sha256");
  for (const rel of Object.keys(files).sort()) h.update(`${rel}:${files[rel].sha256}\n`);
  const m = { chrome: markers.chrome, ffmpeg: markers.ffmpeg, node: markers.node, app: markers.app, builtAt: markers.builtAt };
  h.update(`markers:${JSON.stringify(m)}\n`);
  return h.digest("hex");
}

/**
 * 从构建产物拍快照。壳 exe 和 sidecar 都是必需品:缺了就抛错,
 * 否则它们只出现在已装清单里、被当成「已移除」,补丁会把用户机器上的程序删掉(审查时实测过)。
 */
export function manifestFromSource({ runtimeDir, exePath, nodePath }) {
  for (const [what, p] of [["壳 exe", exePath], ["Node sidecar", nodePath]]) {
    if (!p || !fs.existsSync(p)) throw new Error(`缺少${what}:${p}(壳 exe 要先 cargo build --release,sidecar 由 prepare-runtime 生成)`);
  }
  const files = {};
  collect(runtimeDir, "runtime", files);
  for (const [rel, abs] of [["overlay-studio.exe", exePath], ["node.exe", nodePath]]) {
    files[rel] = { sha256: sha256File(abs), size: fs.statSync(abs).size, abs };
  }
  return finish(files, readMarkers(path.join(runtimeDir, "VERSIONS.json")), `source:${runtimeDir}`);
}

/** 从已装目录拍快照 */
export function manifestFromInstall(installDir) {
  const files = {};
  collect(installDir, "", files);
  return finish(files, readMarkers(path.join(installDir, "runtime", "VERSIONS.json")), `install:${installDir}`);
}

function finish(files, markers, origin) {
  const id = manifestId(files, markers);
  return { version: 1, id, createdAt: new Date().toISOString(), origin, markers, files };
}

/** 存盘/随补丁分发的形态:去掉 abs(只在本机有意义)和 origin(带开发者的本机路径和用户名) */
export function stripAbs(manifest) {
  const files = {};
  for (const rel of Object.keys(manifest.files).sort()) files[rel] = { sha256: manifest.files[rel].sha256, size: manifest.files[rel].size };
  const { abs: _a, origin: _o, ...rest } = manifest;
  return { ...rest, files };
}

/** 读一份存盘的清单,顺手校验路径 */
export function loadManifest(file) {
  // 清单可能被 PowerShell 5.1 之类的工具重新存过,开头带 UTF-8 BOM,JSON.parse 不认
  const m = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (!m || m.version !== 1 || typeof m.files !== "object" || typeof m.id !== "string") throw new Error(`不是补丁清单:${file}`);
  for (const rel of Object.keys(m.files)) assertSafeRel(rel);
  return m;
}

/** 两份清单的差异:以 base 为已装状态,current 为目标状态 */
export function diffManifests(base, current) {
  const changed = [], added = [], deleted = [];
  for (const [rel, f] of Object.entries(current.files)) {
    const b = base.files[rel];
    if (!b) added.push(rel);
    else if (b.sha256 !== f.sha256) changed.push(rel);
  }
  for (const rel of Object.keys(base.files)) if (!current.files[rel]) deleted.push(rel);
  const markerDiff = ["chrome", "ffmpeg", "node", "app", "builtAt"].filter((k) => (base.markers?.[k] ?? "") !== (current.markers?.[k] ?? ""));
  return { changed: changed.sort(), added: added.sort(), deleted: deleted.sort(), markerDiff };
}

/** 一个相对路径属于哪一类,汇总用 */
export function categoryOf(rel) {
  if (rel === "overlay-studio.exe") return "shell";
  if (rel === "node.exe") return "node";
  if (rel.startsWith("runtime/app/node_modules/")) return "deps";
  if (rel.startsWith("runtime/app/dist/")) return "dist";
  return "app";
}

// 直接运行:node patch-manifest.mjs <安装目录|--source> [--out 文件]
const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === selfPath) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const target = args.find((a) => !a.startsWith("--") && a !== out);
  const desktop = path.resolve(path.dirname(selfPath), "..");
  let m;
  if (!target || args.includes("--source")) {
    m = manifestFromSource({
      runtimeDir: path.join(desktop, "src-tauri", "runtime"),
      exePath: path.join(desktop, "src-tauri", "target", "release", "overlay-studio.exe"),
      nodePath: path.join(desktop, "src-tauri", "binaries", "node-x86_64-pc-windows-msvc.exe"),
    });
  } else {
    m = manifestFromInstall(path.resolve(target));
  }
  const text = JSON.stringify(stripAbs(m), null, 2);
  if (out) {
    fs.writeFileSync(out, text);
    console.log(`written ${out} (${Object.keys(m.files).length} files, id ${m.id.slice(0, 12)})`);
  } else {
    console.log(text);
  }
}
