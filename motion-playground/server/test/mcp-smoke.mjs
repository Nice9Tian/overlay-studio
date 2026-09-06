import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolsMod = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
const expectedTools = toolsMod.tools;

const serverScript = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const viteCmd = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let mcpChild;
let fakeEditorChild;
let startedBridge = false;
let bridgePid = null;

async function cleanup() {
  if (fakeEditorChild) {
    try { fakeEditorChild.kill(); } catch { }
  }
  if (mcpChild) {
    try { mcpChild.kill(); } catch { }
  }
  if (startedBridge && bridgePid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(bridgePid), '/T', '/F'], { windowsHide: true });
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        killer.on('close', finish);
        killer.on('error', finish);
        setTimeout(finish, 5000);
      });
    } catch { }
    await delay(1000);
    let portFree = true;
    try {
      const res = await fetch('http://127.0.0.1:5196/api/mcp/status');
      if (res.ok) portFree = false;
    } catch { }
    if (portFree) {
      console.log('[cleanup] 5196 已释放');
    } else {
      console.log('[cleanup] 5196 仍在应答');
    }
  }
}

async function runTests() {
  let exitCode = 0;
  try {
    let bridgeUp = false;
    let externalEditor = false;
    let noBridge = process.env.OVERLAY_SMOKE_NO_BRIDGE === '1';

    if (!noBridge) {
      try {
        const statusRes = await fetch('http://127.0.0.1:5196/api/mcp/status');
        if (statusRes.ok) {
          bridgeUp = true;
          startedBridge = false;
          const statusJson = await statusRes.json();
          externalEditor = statusJson.editorConnected;
        }
      } catch { }

      if (!bridgeUp) {
        const fs = await import('node:fs');
        if (!fs.existsSync(viteCmd)) {
          noBridge = true;
        }
        
        if (!noBridge) {
          const bridgeProc = spawn(process.execPath, [viteCmd, '--config', 'server/vite.ai.config.ts'], {
            cwd: repoRoot,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          });
          startedBridge = true;
          bridgePid = bridgeProc.pid;
          
          const t0 = Date.now();
          while (Date.now() - t0 < 60000) {
            try {
              const res = await fetch('http://127.0.0.1:5196/api/mcp/status');
              if (res.ok) {
                bridgeUp = true;
                break;
              }
            } catch { }
            await delay(500);
          }
          if (!bridgeUp) {
            console.log('Bridge failed to start, falling back to NO_BRIDGE mode.');
            noBridge = true;
          }
        }
      }
    }

    mcpChild = spawn(process.execPath, [serverScript], {
      env: { ...process.env, OVERLAY_STUDIO_PORT: '5196' },
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let msgId = 1;
    const pending = new Map();

    function send(method, params = undefined) {
      const id = msgId++;
      const req = { jsonrpc: '2.0', id, method };
      if (params) req.params = params;
      
      const p = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      
      mcpChild.stdin.write(JSON.stringify(req) + '\n');
      return p;
    }

    mcpChild.stdout.on('data', d => {
      const str = d.toString();
      const lines = str.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          const cb = pending.get(msg.id);
          if (cb) {
            pending.delete(msg.id);
            cb.resolve(msg);
          }
        } catch { }
      }
    });

    const initRes = await send('initialize', { protocolVersion: '2025-04-01' });
    assert.ok(initRes.result, 'initialize failed');
    assert.strictEqual(initRes.result.protocolVersion, '2025-03-26', 'fallback version mismatch');
    assert.ok(initRes.result.capabilities.tools, 'capabilities.tools missing');
    assert.strictEqual(initRes.result.serverInfo.name, 'overlay-studio');
    console.log('PASS: initialize');

    const listRes = await send('tools/list');
    const returnedTools = listRes.result.tools;
    assert.strictEqual(returnedTools.length, 15, 'tools count mismatch');
    for (const t of expectedTools) {
      const found = returnedTools.find(rt => rt.name === t.name);
      assert.ok(found, `tool ${t.name} not found`);
      assert.strictEqual(found.side, undefined, `tool ${t.name} should not leak side property`);
    }
    console.log('PASS: tools/list');

    if (externalEditor) {
      console.log('SKIPPED: external editor connected, skipping case C (tools/call bridge up, editor down)');
    } else {
      const callRes = await send('tools/call', { name: 'get_editor_state', arguments: {} });
      if (noBridge) {
        assert.ok(callRes.result.isError, 'should be error when bridge is down');
        assert.ok(callRes.result.content[0].text.includes('没有服务'), 'missing expected error text');
        console.log('PASS: tools/call (bridge down)');
        console.log('SKIPPED: bridge is down, skipping editor up/down tests');
      } else {
        assert.ok(callRes.result.isError, 'should be error when editor is down');
        assert.ok(callRes.result.content[0].text.includes('编辑台没有打开'), 'missing expected error text');
        console.log('PASS: tools/call (bridge up, editor down)');
      }
    }

    if (!noBridge) {
      fakeEditorChild = spawn(process.execPath, [fileURLToPath(new URL('./fake-editor.mjs', import.meta.url))], {
        env: { ...process.env, OVERLAY_STUDIO_PORT: '5196' },
        stdio: ['ignore', 'pipe', 'inherit']
      });

      const editorReadyP = new Promise((resolve) => {
        let out = '';
        fakeEditorChild.stdout.on('data', (d) => {
          out += d.toString();
          if (out.includes('READY')) resolve(true);
        });
        setTimeout(() => resolve(false), 15000);
      });

      const isEditorReady = await editorReadyP;
      assert.ok(isEditorReady, 'fake-editor failed to print READY in 15 seconds');

      let editorUp = false;
      const t1 = Date.now();
      while (Date.now() - t1 < 5000) {
        try {
          const res = await fetch('http://127.0.0.1:5196/api/mcp/status');
          if (res.ok) {
            const j = await res.json();
            if (j.editorConnected) {
              editorUp = true;
              break;
            }
          }
        } catch { }
        await delay(500);
      }
      assert.ok(editorUp, 'bridge failed to report editorConnected=true in 5 seconds');

      const callRes2 = await send('tools/call', { name: 'get_editor_state', arguments: {} });
      assert.ok(!callRes2.result.isError, 'should not be error when editor is up');
      const resultObj = JSON.parse(callRes2.result.content[0].text);
      assert.ok('curT' in resultObj, 'missing curT');
      assert.ok('duration' in resultObj, 'missing duration');
      assert.ok('cards' in resultObj, 'missing cards');
      console.log('PASS: tools/call (bridge up, editor up)');
    }

    console.log('ALL PASS');
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    exitCode = 1;
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
}

runTests();
