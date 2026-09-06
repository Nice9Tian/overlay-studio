import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

// 动态载入工具表以便校验
const toolsMod = await import(new URL('../mcp-tools.mjs', import.meta.url).href);
const expectedTools = toolsMod.tools;

const serverScript = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));

const child = spawn(process.execPath, [serverScript], {
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
  
  child.stdin.write(JSON.stringify(req) + '\n');
  return p;
}

child.stdout.on('data', d => {
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
    } catch(e) {}
  }
});

async function runTests() {
  try {
    // 1. initialize
    const initRes = await send('initialize', { protocolVersion: '2025-04-01' }); // 未知版本
    assert.ok(initRes.result, 'initialize failed');
    assert.strictEqual(initRes.result.protocolVersion, '2025-03-26', 'fallback version mismatch');
    assert.ok(initRes.result.capabilities.tools, 'capabilities.tools missing');
    assert.strictEqual(initRes.result.serverInfo.name, 'overlay-studio');
    console.log('PASS: initialize');

    // 2. tools/list
    const listRes = await send('tools/list');
    const returnedTools = listRes.result.tools;
    assert.strictEqual(returnedTools.length, 15, 'tools count mismatch');
    for (const t of expectedTools) {
      const found = returnedTools.find(rt => rt.name === t.name);
      assert.ok(found, `tool ${t.name} not found`);
      assert.strictEqual(found.side, undefined, `tool ${t.name} should not leak side property`);
    }
    console.log('PASS: tools/list');

    // Check if bridge is up on 5196
    let bridgeUp = false;
    let editorUp = false;
    try {
      const statusRes = await fetch('http://127.0.0.1:5196/api/mcp/status');
      if (statusRes.ok) {
        bridgeUp = true;
        const statusJson = await statusRes.json();
        editorUp = statusJson.editorConnected;
      }
    } catch (e) {}

    // 3. tools/call when bridge is not up OR bridge is up
    const callRes = await send('tools/call', { name: 'get_editor_state', arguments: {} });
    if (!bridgeUp) {
      assert.ok(callRes.result.isError, 'should be error when bridge is down');
      assert.ok(callRes.result.content[0].text.includes('没有服务'), 'missing expected error text');
      console.log('PASS: tools/call (bridge down)');
      console.log('SKIPPED: bridge is down, skipping editor up/down tests');
    } else {
      if (!editorUp) {
        assert.ok(callRes.result.isError, 'should be error when editor is down');
        assert.ok(callRes.result.content[0].text.includes('编辑台没有打开'), 'missing expected error text');
        console.log('PASS: tools/call (bridge up, editor down)');
        console.log('SKIPPED: editor is down, skipping editor up test');
      } else {
        assert.ok(!callRes.result.isError, 'should not be error when editor is up');
        const resultObj = JSON.parse(callRes.result.content[0].text);
        assert.ok('curT' in resultObj, 'missing curT');
        assert.ok('duration' in resultObj, 'missing duration');
        assert.ok('cards' in resultObj, 'missing cards');
        console.log('PASS: tools/call (bridge up, editor up)');
      }
    }
    
    console.log('ALL PASS');
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    child.kill();
    process.exit(1);
  }
}

runTests();
