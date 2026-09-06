import { execFileSync, spawn } from 'node:child_process';
import { getClaudeProvider, startRun as startClaude } from './claude.mjs';
import { getAgyProvider, startRun as startAgy } from './agy.mjs';
import { getCodexProvider, startRun as startCodex } from './codex.mjs';

const exeCache = new Map();

export function resolveExe(name, fallback) {
  if (exeCache.has(name)) return exeCache.get(name);
  try {
    const stdout = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      exeCache.set(name, lines[0]);
      return lines[0];
    }
  } catch (e) {}
  exeCache.set(name, fallback);
  return fallback;
}

let providersCache = null;
let providersCacheTime = 0;

export async function listProviders(opts = {}) {
  const now = Date.now();
  if (!opts.refresh && providersCache && now - providersCacheTime < 5000) {
    return providersCache;
  }
  providersCache = await Promise.all([
    getClaudeProvider(),
    getAgyProvider(),
    getCodexProvider()
  ]);
  providersCacheTime = now;
  return providersCache;
}

export function startRun(opts) {
  if (opts.provider === 'claude') return startClaude(opts);
  if (opts.provider === 'agy') return startAgy(opts);
  if (opts.provider === 'codex') return startCodex(opts);
  throw new Error(`Unknown provider: ${opts.provider}`);
}

export function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let i = 0;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  };
}

export function truncate(s, maxLength) {
  if (typeof s !== 'string') return s;
  return s.length > maxLength ? s.slice(0, maxLength) + '...' : s;
}

export function spawnCli(exePath, args, opts, onEvent, providerName) {
  const safeOnEvent = (ev) => {
    try { onEvent(ev); } catch (e) {}
  };

  let actualCmd = exePath;
  let actualArgs = args;
  if (actualCmd.toLowerCase().endsWith('.cmd') || actualCmd.toLowerCase().endsWith('.bat')) {
    actualCmd = 'cmd.exe';
    actualArgs = ['/c', exePath, ...args];
  }

  const child = spawn(actualCmd, actualArgs, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    windowsHide: true,
    shell: false
  });

  safeOnEvent({ type: 'status', text: `已启动 ${providerName || 'CLI'}` });

  let stderrBuffer = '';
  let hasDone = false;
  let isAborted = false;
  
  let resolveDone;
  const donePromise = new Promise(r => { resolveDone = r; });
  let debounceTimer = null;

  const flushStderr = () => {
    if (stderrBuffer) {
      safeOnEvent({ type: 'status', text: truncate(stderrBuffer, 2048) });
      stderrBuffer = '';
    }
  };

  const finish = (ev) => {
    if (hasDone) return;
    hasDone = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    flushStderr();
    if (ev && !isAborted) safeOnEvent(ev);
    resolveDone();
  };

  child.stderr.on('data', (data) => {
    stderrBuffer += data.toString('utf8');
    if (stderrBuffer.length > 2048) {
       stderrBuffer = truncate(stderrBuffer, 2048);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
       flushStderr();
    }, 200);
  });

  child.on('close', (code) => {
    if (isAborted) {
      finish();
      return;
    }
    if (code !== 0 && !hasDone) {
      finish({ type: 'error', message: `Process exited with code ${code}.` });
    } else {
      finish();
    }
  });

  child.on('error', (err) => {
      if (!hasDone) finish({ type: 'error', message: `Spawn failed: ${err.message}` });
  });

  let abortTimer;

  const abort = () => {
    if (isAborted || hasDone) return;
    isAborted = true;
    safeOnEvent({ type: 'status', text: '已中止' });
    
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {});
    } catch (e) {}
    
    // Fallback if taskkill fails
    try { child.kill('SIGKILL'); } catch (e) {}

    abortTimer = setTimeout(() => {
      if (!hasDone) {
         hasDone = true;
         resolveDone();
      }
    }, 2000);
  };

  const cleanupAbortTimer = () => {
    if (abortTimer) clearTimeout(abortTimer);
  };
  
  child.on('close', cleanupAbortTimer);
  child.on('error', cleanupAbortTimer);

  return { child, safeOnEvent, finish, abort, donePromise };
}
