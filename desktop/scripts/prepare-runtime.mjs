import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'src-tauri', 'runtime');
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

const isCheck = process.argv.includes('--check');

function log(msg) {
  console.log(`[prepare-runtime] ${msg}`);
}

function getDirSize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const files = fs.readdirSync(dirPath);
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(dirPath, files[i]);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      size += getDirSize(filePath);
    } else {
      size += stats.size;
    }
  }
  return size;
}

function formatSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Sidecar
const sidecarPath = path.join(BINARIES_DIR, 'node-x86_64-pc-windows-msvc.exe');
function prepareSidecar() {
  const start = Date.now();
  if (isCheck) {
    if (!fs.existsSync(sidecarPath)) {
      console.error(`[check] sidecar missing: ${sidecarPath}`);
      process.exit(1);
    }
    log(`sidecar check passed`);
    return;
  }
  log(`Preparing sidecar...`);
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, sidecarPath);
  const size = fs.statSync(sidecarPath).size;
  log(`Sidecar copied. Size: ${formatSize(size)}MB, Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// App
const APP_SRC = path.join(ROOT, '..', 'motion-playground');
const APP_DST = path.join(RUNTIME_DIR, 'app');
// 导出静态模式(见 DESIGN.md 第二轮 F 节)要的构建产物:
// 导出页 ?export=1 不调任何 /api/,所以它可以完全从这份 dist 里离线加载,
// Chrome 走请求拦截 + CDP 管道,导出时不再需要 Vite 端口。
const APP_DIST_INDEX = path.join(APP_DST, 'dist', 'index.html');

function shouldExclude(src) {
  const rel = path.relative(APP_SRC, src);
  if (!rel) return false;
  const parts = rel.split(path.sep);
  
  if (parts[0] === 'node_modules') return true;
  if (parts[0] === 'exports') return true;
  if (parts[0] === 'dist') return true;
  if (parts[0] === '.vite') return true;
  if (parts[0] === '.git') return true;
  
  if (parts[0] === 'public' && parts[1] === '_media') return true;
  if (parts[0] === 'public' && parts[1] === '_fxframes') return true;
  if (parts[0] === 'src' && parts[1] === 'assets' && parts[2] === 'fonts' && parts[3] && parts[3] !== 'README.md') return true;
  if (parts[0] === 'public' && parts[1] === 'sfx' && parts[2] && parts[2] !== 'README.md') return true;
  if (parts[0] === 'public' && parts[1] === 'logos' && rel.toLowerCase().endsWith('.png')) return true;
  if (parts[0] === 'public' && parts[1] === 'demo' && parts[2] && !['demo-overlay.json', 'demo.srt', 'README.txt'].includes(parts[2])) return true;
  
  if (rel.endsWith('.log')) return true;
  if (rel.endsWith('.mp4') || rel.endsWith('.mov') || rel.endsWith('.webm')) return true;
  
  return false;
}

function prepareApp() {
  const start = Date.now();
  if (isCheck) {
    if (!fs.existsSync(APP_DST)) {
      console.error(`[check] app dir missing: ${APP_DST}`);
      process.exit(1);
    }
    if (!fs.existsSync(path.join(APP_DST, 'node_modules'))) {
      console.error(`[check] app/node_modules missing`);
      process.exit(1);
    }
    const mustExist = [
      path.join(APP_DST, 'node_modules', 'vite', 'bin', 'vite.js'),
      path.join(APP_DST, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    ];
    for (const p of mustExist) {
      if (!fs.existsSync(p)) {
        console.error(`npm ci 结束了但缺 ${p}。多半是 npm 拦了安装脚本(esbuild 的 postinstall 没跑)。到 ${APP_DST} 里执行 npm approve-scripts esbuild puppeteer 后重跑本脚本。`);
        process.exit(1);
      }
    }
    if (!fs.existsSync(APP_DIST_INDEX)) {
      console.error(`[check] 缺 ${APP_DIST_INDEX}。导出的静态模式(OVERLAY_EXPORT_STATIC_DIR)要用这份 dist，缺了就只能回到需要端口的服务器模式。重跑 npm run prepare-runtime。`);
      process.exit(1);
    }
    log(`app check passed`);
    return;
  }
  log(`Preparing app...`);
  if (fs.existsSync(APP_DST)) {
    fs.rmSync(APP_DST, { recursive: true, force: true });
  }
  fs.mkdirSync(APP_DST, { recursive: true });
  fs.cpSync(APP_SRC, APP_DST, {
    recursive: true,
    filter: (src) => {
      return !shouldExclude(src);
    }
  });
  
  log(`Running npm ci in app directory...`);
  const npmRes = spawnSync('npm', ['ci'], {
    cwd: APP_DST,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
    shell: true,
    stdio: 'inherit'
  });
  if (npmRes.status !== 0) {
    console.error(`npm ci failed in ${APP_DST}`);
    process.exit(1);
  }
  
  const mustExist = [
    path.join(APP_DST, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(APP_DST, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  ];
  for (const p of mustExist) {
    if (!fs.existsSync(p)) {
      console.error(`npm ci 结束了但缺 ${p}。多半是 npm 拦了安装脚本(esbuild 的 postinstall 没跑)。到 ${APP_DST} 里执行 npm approve-scripts esbuild puppeteer 后重跑本脚本。`);
      process.exit(1);
    }
  }
  
  // 构建导出静态包。为什么在这里、为什么用 runtime/app 自己的 node_modules?
  // 答:导出的静态模式要一份 dist/(index.html + assets/ + public 的副本),Chrome 靠请求拦截读它,
  // 这样导出就不再依赖 5177 端口和 Vite 进程。必须用 runtime/app 里刚 npm ci 出来的那套依赖
  // (cwd=runtime/app,npx 会优先取本地 .bin),否则版本可能和运行时跑的 Vite 对不上。
  log(`Running vite build in app directory...`);
  const buildRes = spawnSync('npx.cmd', ['vite', 'build'], {
    cwd: APP_DST,
    env: { ...process.env },
    shell: true,
    stdio: 'inherit'
  });
  if (buildRes.status !== 0) {
    console.error(`vite build failed in ${APP_DST}`);
    process.exit(1);
  }
  if (!fs.existsSync(APP_DIST_INDEX)) {
    console.error(`vite build 结束了但缺 ${APP_DIST_INDEX}。没有这份 dist,导出只能回到需要端口的服务器模式。`);
    process.exit(1);
  }
  log(`Static export bundle built: ${APP_DIST_INDEX} (${formatSize(getDirSize(path.join(APP_DST, 'dist')))}MB)`);

  const size = getDirSize(APP_DST);
  log(`App prepared. Size: ${formatSize(size)}MB, Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// Chrome
const CHROME_DST_DIR = path.join(RUNTIME_DIR, 'chrome');
function prepareChrome() {
  const start = Date.now();
  const puppeteerDir = path.join(APP_DST, 'node_modules', 'puppeteer-core', 'lib');
  const candidates = [
    path.join(puppeteerDir, 'esm', 'puppeteer', 'revisions.js'),
    path.join(puppeteerDir, 'puppeteer', 'revisions.js'),
    path.join(puppeteerDir, 'cjs', 'puppeteer', 'revisions.js'),
  ];
  let revPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      revPath = c;
      break;
    }
  }
  
  if (!revPath) {
    console.error(`revisions.js not found. Tried:\n${candidates.join('\\n')}`);
    process.exit(1);
  }
  const revContent = fs.readFileSync(revPath, 'utf8');
  const match = revContent.match(/chrome:\s*['"]([^'"]+)['"]/);
  if (!match) {
    console.error(`Could not parse chrome version from ${revPath}`);
    process.exit(1);
  }
  const chromeVer = match[1];
  log(`Detected required Chrome version: ${chromeVer}`);

  const userProfile = os.homedir();
  const cacheDir = path.join(userProfile, '.cache', 'puppeteer', 'chrome', `win64-${chromeVer}`);
  const destDir = path.join(CHROME_DST_DIR, 'chrome', `win64-${chromeVer}`);
  const chromeExePath = path.join(destDir, 'chrome-win64', 'chrome.exe');

  if (isCheck) {
    if (!fs.existsSync(chromeExePath)) {
      console.error(`[check] chrome.exe missing at ${chromeExePath}`);
      process.exit(1);
    }
    log(`chrome check passed`);
    return chromeVer;
  }

  const verRoot = path.join(CHROME_DST_DIR, 'chrome');
  if (fs.existsSync(verRoot)) {
    for (const d of fs.readdirSync(verRoot)) {
      if (d !== `win64-${chromeVer}`) {
        log(`清理旧版 Chrome: ${d}`);
        fs.rmSync(path.join(verRoot, d), { recursive: true, force: true });
      }
    }
  }

  log(`Preparing Chrome...`);
  if (!fs.existsSync(chromeExePath)) {
    if (fs.existsSync(cacheDir)) {
      log(`Found cached Chrome at ${cacheDir}, copying...`);
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(cacheDir, destDir, { 
        recursive: true,
        filter: (src) => {
          return !src.includes('chrome-headless-shell');
        }
      });
    } else {
      log(`Cached Chrome not found, running puppeteer browsers install...`);
      const npxRes = spawnSync('npx.cmd', ['puppeteer', 'browsers', 'install', `chrome@${chromeVer}`, '--path', CHROME_DST_DIR], {
        cwd: APP_DST,
        shell: true,
        stdio: 'inherit'
      });
      if (npxRes.status !== 0) {
        console.error(`Failed to install Chrome using npx puppeteer browsers install`);
        process.exit(1);
      }
    }
  } else {
    log(`Chrome already exists in runtime, skipping download.`);
  }

  if (!fs.existsSync(chromeExePath)) {
    console.error(`Assertion failed: chrome.exe not found at ${chromeExePath}`);
    process.exit(1);
  }

  const size = getDirSize(CHROME_DST_DIR);
  log(`Chrome prepared. Size: ${formatSize(size)}MB, Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return chromeVer;
}

// FFmpeg
const FFMPEG_DST_DIR = path.join(RUNTIME_DIR, 'ffmpeg');
function findFFmpeg() {
  try {
    const whereRes = execSync('where ffmpeg', { encoding: 'utf8' }).split('\n')[0].trim();
    if (whereRes && fs.existsSync(whereRes)) {
      const binDir = path.dirname(whereRes);
      if (fs.existsSync(path.join(binDir, 'ffprobe.exe'))) {
        log(`Found ffmpeg in PATH: ${binDir}`);
        return binDir;
      }
    }
  } catch (e) {}

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const wingetDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetDir)) {
      const packages = fs.readdirSync(wingetDir);
      const ffmpegPackage = packages.find(p => p.startsWith('Gyan.FFmpeg_'));
      if (ffmpegPackage) {
        const pkgDir = path.join(wingetDir, ffmpegPackage);
        const subDirs = fs.readdirSync(pkgDir);
        const ffmpegDir = subDirs.find(d => d.startsWith('ffmpeg-'));
        if (ffmpegDir) {
          const binDir = path.join(pkgDir, ffmpegDir, 'bin');
          if (fs.existsSync(path.join(binDir, 'ffmpeg.exe')) && fs.existsSync(path.join(binDir, 'ffprobe.exe'))) {
            log(`Found ffmpeg in Winget: ${binDir}`);
            return binDir;
          }
        }
      }
    }
  }
  return null;
}

function prepareFFmpeg() {
  const start = Date.now();
  if (isCheck) {
    if (!fs.existsSync(path.join(FFMPEG_DST_DIR, 'ffmpeg.exe')) || !fs.existsSync(path.join(FFMPEG_DST_DIR, 'ffprobe.exe'))) {
      console.error(`[check] ffmpeg/ffprobe missing in ${FFMPEG_DST_DIR}`);
      process.exit(1);
    }
    log(`ffmpeg check passed`);
    try {
      const verStr = execSync(`"${path.join(FFMPEG_DST_DIR, 'ffmpeg.exe')}" -version`, { encoding: 'utf8' }).split('\n')[0].trim();
      return verStr;
    } catch(e) {
      console.error(`[check] failed to get ffmpeg version`);
      process.exit(1);
    }
  }

  log(`Preparing FFmpeg...`);
  const binDir = findFFmpeg();
  if (!binDir) {
    console.error(`ffmpeg/ffprobe not found in PATH or winget cache.`);
    console.error(`Please run: winget install --id Gyan.FFmpeg -e`);
    process.exit(1);
  }

  fs.mkdirSync(FFMPEG_DST_DIR, { recursive: true });
  fs.copyFileSync(path.join(binDir, 'ffmpeg.exe'), path.join(FFMPEG_DST_DIR, 'ffmpeg.exe'));
  fs.copyFileSync(path.join(binDir, 'ffprobe.exe'), path.join(FFMPEG_DST_DIR, 'ffprobe.exe'));

  const parentDir = path.dirname(binDir);
  const files = fs.readdirSync(parentDir);
  for (const file of files) {
    if (file.toUpperCase().startsWith('LICENSE') || file.toUpperCase().startsWith('README')) {
      fs.copyFileSync(path.join(parentDir, file), path.join(FFMPEG_DST_DIR, file));
    }
  }

  const verStr = execSync(`"${path.join(FFMPEG_DST_DIR, 'ffmpeg.exe')}" -version`, { encoding: 'utf8' }).split('\n')[0].trim();

  const size = getDirSize(FFMPEG_DST_DIR);
  log(`FFmpeg prepared. Size: ${formatSize(size)}MB, Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return verStr;
}

// Versions
function hashAppSrc() {
  const files = [];
  function scan(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (shouldExclude(p)) continue;
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        scan(p);
      } else {
        const rel = path.relative(APP_SRC, p);
        files.push(`${rel}|${s.size}|${s.mtimeMs}`);
      }
    }
  }
  scan(APP_SRC);
  files.sort();
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex');
}

function prepareVersions(chromeVer, ffmpegVer) {
  const start = Date.now();
  const versionsPath = path.join(RUNTIME_DIR, 'VERSIONS.json');
  
  let appVer = "unknown";
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(APP_SRC, 'package.json'), 'utf8'));
    appVer = pkgJson.version;
  } catch (e) {
    console.error(`Failed to read app/package.json`);
    if (isCheck) process.exit(1);
  }

  const appSrcHash = hashAppSrc();
  const nodeVer = execFileSync(sidecarPath, ['--version']).toString().trim();

  const versionsObj = {
    node: nodeVer,
    chrome: chromeVer,
    ffmpeg: ffmpegVer,
    app: appVer,
    // 这份 runtime 带了导出静态包(runtime/app/dist)。为什么要记进来?
    // 答:壳会无条件把 OVERLAY_EXPORT_STATIC_DIR 指到 app/dist,
    // 「关于」对话框和排障时能一眼看出这个 runtime 是不是带 dist 的版本。
    dist: true,
    appSrcHash: appSrcHash,
    builtAt: new Date().toISOString()
  };

  if (isCheck) {
    if (!fs.existsSync(versionsPath)) {
      console.error(`[check] VERSIONS.json missing`);
      process.exit(1);
    }
    const current = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
    if (current.node !== versionsObj.node || current.chrome !== versionsObj.chrome || current.app !== versionsObj.app || current.appSrcHash !== versionsObj.appSrcHash) {
      if (current.appSrcHash !== versionsObj.appSrcHash) {
        console.error(`[check] runtime/app 落后于 motion-playground，请重跑 npm run prepare-runtime`);
      } else {
        console.error(`[check] VERSIONS.json mismatch. Expected node ${versionsObj.node}, chrome ${versionsObj.chrome}, app ${versionsObj.app}. Got ${JSON.stringify(current)}`);
      }
      process.exit(1);
    }
    log(`VERSIONS.json check passed`);
    return versionsObj;
  }

  log(`Preparing VERSIONS.json...`);
  fs.writeFileSync(versionsPath, JSON.stringify(versionsObj, null, 2), 'utf8');
  
  log(`VERSIONS.json written. Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return versionsObj;
}

function main() {
  const startTime = Date.now();
  log(`Starting prepare-runtime... (check=${isCheck})`);
  prepareSidecar();
  prepareApp();
  const chromeVer = prepareChrome();
  const ffmpegVer = prepareFFmpeg();
  prepareVersions(chromeVer, ffmpegVer);
  log(`Done! Total Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main();
