import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';

const ROOT = path.resolve(process.cwd());
const LOG_DIR = path.join(os.tmpdir(), 'overlay-studio', 'p1-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

async function checkSyntax() {
  const files = [
    'server/mcp-server.mjs',
    'server/mcp-tools.mjs',
    'server/stt.mjs',
    'server/test/fake-runner.mjs',
    'server/test/fake-editor.mjs',
    'server/test/mcp-smoke.mjs'
  ];
  for (const file of files) {
    const p = spawnSync(process.execPath, ['--check', file], { cwd: ROOT });
    if (p.status !== 0) {
      throw new Error(`Syntax check failed for ${file}: ${p.stderr.toString()}`);
    }
  }
  console.log('PASS: node --check');
}

function startVite(envOverrides = {}, logName = 'vite') {
  const env = { ...process.env, ...envOverrides };
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const outLog = fs.openSync(path.join(LOG_DIR, `${logName}.log`), 'a');
  const errLog = fs.openSync(path.join(LOG_DIR, `${logName}.err.log`), 'a');
  
  const child = spawn(process.execPath, [viteBin, '--config', 'server/vite.ai.config.ts'], {
    cwd: ROOT,
    windowsHide: true,
    env,
    stdio: ['ignore', outLog, errLog]
  });
  
  return child;
}

async function waitForBridge() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5196/api/mcp/status');
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Bridge did not start in time');
}

async function testChatAndAbort() {
  const res = await fetch('http://127.0.0.1:5196/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ provider: 'claude', prompt: 'hello' })
  });
  assert.ok(res.ok, 'chat request failed');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  let gotRun = false, gotText = false, gotDone = false;
  let _activeRunId = null;
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    
    let parts = buffer.split('\n\n');
    buffer = parts.pop();
    
    for (const part of parts) {
      if (part.startsWith('data: ')) {
        const ev = JSON.parse(part.slice(6));
        if (ev.type === 'run') { gotRun = true; _activeRunId = ev.runId; }
        if (ev.type === 'text') gotText = true;
        if (ev.type === 'done') gotDone = true;
      }
    }
    if (gotRun && gotText && gotDone) break;
  }
  assert.ok(gotRun && gotText && gotDone, 'Missing run, text or done events in chat stream');
  console.log('PASS: Chat stream (run, text, done)');

  // Test Abort
  const res2 = await fetch('http://127.0.0.1:5196/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ provider: 'claude', prompt: 'hello' })
  });
  const reader2 = res2.body.getReader();
  let runId2 = null;
  while (true) {
    const { done: _done, value } = await reader2.read();
    buffer += decoder.decode(value, { stream: true });
    let parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      if (part.startsWith('data: ')) {
        const ev = JSON.parse(part.slice(6));
        if (ev.type === 'run') {
          runId2 = ev.runId;
          break;
        }
      }
    }
    if (runId2) break;
  }
  
  const abortRes = await fetch('http://127.0.0.1:5196/api/ai/abort', {
    method: 'POST',
    body: JSON.stringify({ runId: runId2 })
  });
  const abortJson = await abortRes.json();
  assert.ok(abortJson.ok, 'abort failed');
  console.log('PASS: Abort');
}

async function runTests() {
  let vites = [];
  try {
    await checkSyntax();

    // Test 1: STT no engine
    console.log('Starting Vite for STT (no engine)...');
    let v1 = startVite({ OVERLAY_AI_FAKE_RUNNER: '1' }, 'v1');
    vites.push(v1);
    await waitForBridge();
    
    const callRes1 = await fetch('http://127.0.0.1:5196/api/mcp/call', {
      method: 'POST',
      body: JSON.stringify({ tool: 'transcribe_video', args: { path: 'dummy.mp4' }})
    });
    const callJson1 = await callRes1.json();
    assert.strictEqual(callJson1.ok, false);
    assert.ok(callJson1.error.includes('这台机器没有语音识别引擎'), 'No engine hint missing');
    console.log('PASS: STT no engine hint');
    
    await testChatAndAbort();
    
    v1.kill('SIGKILL');
    vites = [];
    await new Promise(r => setTimeout(r, 1000));
    
    // Test 2: STT fake engine
    console.log('Starting Vite for STT (fake engine)...');
    const fakeCmd = path.join(ROOT, 'server', 'test', 'fake-stt.cmd');
    let v2 = startVite({ 
      OVERLAY_AI_FAKE_RUNNER: '1',
      OVERLAY_STT_CMD: `"${fakeCmd}" {wav} {srt} {lang}`
    }, 'v2');
    vites.push(v2);
    await waitForBridge();
    
    const realVideoPath = path.join(ROOT, 'public', '_media', 'cd68a57ebdb66a89cf61736d2f53b0f6.mp4');
    const callRes2 = await fetch('http://127.0.0.1:5196/api/mcp/call', {
      method: 'POST',
      body: JSON.stringify({ tool: 'transcribe_video', args: { path: realVideoPath }})
    });
    const callJson2 = await callRes2.json();
    assert.ok(callJson2.ok, 'Fake engine transcribe failed: ' + callJson2.error);
    assert.ok(callJson2.result.srt_text.includes('这是一个假引擎生成的字幕'), 'SRT text mismatch');
    console.log('PASS: STT fake engine');
    
    v2.kill('SIGKILL');
    vites = [];
    await new Promise(r => setTimeout(r, 1000));
    
    // Test 3: Failsafe
    console.log('Starting Vite for Failsafe check...');
    let v3 = startVite({ 
      OVERLAY_AI_FAKE_RUNNER: '0',
      OVERLAY_AI_RUNNER_MODULE: './runners/not-exist.mjs'
    }, 'v3');
    vites.push(v3);
    await waitForBridge();
    
    const statusRes = await fetch('http://127.0.0.1:5196/api/mcp/status');
    assert.ok(statusRes.ok, '/api/mcp/status should be ok');
    console.log('PASS: Failsafe bridge up');
    
    const provRes = await fetch('http://127.0.0.1:5196/api/ai/providers');
    assert.strictEqual(provRes.status, 503, 'Expected 503 for missing runner');
    const provJson = await provRes.json();
    assert.strictEqual(provJson.ok, false);
    assert.ok(provJson.error.includes('Runner 尚未就绪或加载失败'), 'Expected failsafe message');
    console.log('PASS: Failsafe provider error');

  } finally {
    for (const v of vites) {
      if (!v.killed) v.kill('SIGKILL');
    }
  }
}

runTests().catch(e => {
  console.error('FAIL:', e);
  process.exit(1);
});
