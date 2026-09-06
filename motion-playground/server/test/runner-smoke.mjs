import fs from 'node:fs';
import path from 'node:path';
import { listProviders, startRun } from '../runners/index.mjs';

const ROOT = path.join(process.cwd(), 'exports', 'ai-workspace');
fs.mkdirSync(ROOT, { recursive: true });

const args = process.argv.slice(2);
const providerName = args.find(a => !a.startsWith('--'));
const noResume = args.includes('--no-resume');
const noAbort = args.includes('--no-abort');
const noText = args.includes('--no-text');
const onlyList = args.includes('--only-list');

if (!providerName && !onlyList) {
  console.error('Usage: node server/test/runner-smoke.mjs <claude|agy|codex> [--no-resume] [--no-abort] [--no-text] [--only-list]');
  process.exitCode = 1;
  process.exit();
}

const mcpScript = process.env.OVERLAY_SMOKE_MCP || path.join(process.cwd(), 'server', 'test', 'fake-mcp-min.mjs');
const mcpOpts = {
  serverName: "overlay-studio",
  command: process.execPath,
  args: [mcpScript],
  env: { OVERLAY_STUDIO_PORT: "5198" }
};

const results = {
  session: false,
  text: false,
  tool_call: false,
  tool_result: false,
  done: false,
  resume: false,
  abort: false
};

const skips = {
  text: noText,
  resume: noResume,
  abort: noAbort
};

async function testList() {
  console.log('--- Testing listProviders ---');
  const list = await listProviders({ refresh: true });
  for (const p of list) {
      console.log(`[${p.id}] available: ${p.available}, version: ${p.version}, path: ${p.path}`);
  }
  return list.every(p => p.available && p.version);
}

function flushText(buf) {
  if (buf.length > 0) {
      console.log(`[RunEvent] text +${buf.length} chars`);
  }
  return '';
}

async function main() {
  const timeoutId = setTimeout(() => {
     console.error('FAIL: 180s timeout hit');
     process.exitCode = 1;
  }, 180000);

  const listPass = await testList();
  if (onlyList) {
      clearTimeout(timeoutId);
      process.exitCode = listPass ? 0 : 1;
      return;
  }

  const collectedStrings = [];

  // ① / ② 首轮
  let captured = null;
  console.log(`\n--- Starting run 1 ---`);
  let tb1 = '';
  const startR1 = Date.now();
  const run1 = startRun({
    provider: providerName,
    prompt: '调用 get_editor_state 然后用一句话告诉我时间轴上有几张卡',
    systemPrompt: '你是 Overlay Studio 的助手，只能用名为 overlay-studio 的 MCP 服务的工具。',
    cwd: ROOT,
    mcp: mcpOpts,
    onEvent: (ev) => {
       if (ev.type === 'text') {
           tb1 += ev.delta;
           results.text = true;
       } else {
           tb1 = flushText(tb1);
           console.log(`[RunEvent] ${JSON.stringify(ev)}`);
           
           if (ev.type === 'error' && ev.message) collectedStrings.push(ev.message);
           if (ev.type === 'status' && ev.text) collectedStrings.push(ev.text);

           if (ev.type === 'session') {
               results.session = true;
               captured = ev.sessionId;
           }
           if (ev.type === 'tool_call') results.tool_call = true;
           if (ev.type === 'tool_result') results.tool_result = true;
           if (ev.type === 'done') results.done = true;
       }
    }
  });
  await run1.done;
  tb1 = flushText(tb1);
  console.log(`--- Run 1 finished in ${Date.now() - startR1}ms ---\n`);
  
  // ③ 续聊
  if (!noResume && captured) {
     console.log(`\n--- Starting run 2 (resume: ${captured}) ---`);
     const startR2 = Date.now();
     let gotText = false;
     let gotDone = false;
     let tb2 = '';
     const run2 = startRun({
       provider: providerName,
       prompt: '刚才那几张卡叫什么',
       systemPrompt: '你是 Overlay Studio 的助手，只能用名为 overlay-studio 的 MCP 服务的工具。',
       cwd: ROOT,
       mcp: mcpOpts,
       sessionId: captured,
       onEvent: (ev) => {
          if (ev.type === 'text') {
              tb2 += ev.delta;
              gotText = true;
          } else {
              tb2 = flushText(tb2);
              console.log(`[RunEvent] ${JSON.stringify(ev)}`);
              if (ev.type === 'error' && ev.message) collectedStrings.push(ev.message);
              if (ev.type === 'status' && ev.text) collectedStrings.push(ev.text);

              if (ev.type === 'done') gotDone = true;
          }
       }
     });
     await run2.done;
     tb2 = flushText(tb2);
     if (gotText && gotDone) {
         results.resume = true;
     }
     console.log(`--- Run 2 finished in ${Date.now() - startR2}ms ---\n`);
  } else if (noResume) {
     results.resume = true;
  }
  
  // ④ abort 测试
  if (!noAbort) {
     console.log(`\n--- Starting run 3 (abort test) ---`);
     const startT = Date.now();
     const run3 = startRun({
       provider: providerName,
       prompt: '讲个长故事',
       systemPrompt: '你是 Overlay Studio 的助手，只能用名为 overlay-studio 的 MCP 服务的工具。',
       cwd: ROOT,
       mcp: mcpOpts,
       onEvent: (ev) => {
           if (ev.type !== 'text') {
               console.log(`[RunEvent] ${JSON.stringify(ev)}`);
               if (ev.type === 'error' && ev.message) collectedStrings.push(ev.message);
               if (ev.type === 'status' && ev.text) collectedStrings.push(ev.text);
           }
       }
     });
     
     setTimeout(() => run3.abort(), 1000);
     await run3.done;
     const dur = Date.now() - startT;
     if (dur <= 2500) { 
         results.abort = true;
     }
     console.log(`--- Run 3 finished in ${dur}ms ---\n`);
  } else {
     results.abort = true;
  }

  if (noText) results.text = true;

  clearTimeout(timeoutId);
  
  console.log('\n=== PASS/FAIL ===');
  let allPass = true;
  for (const [k, v] of Object.entries(results)) {
     let display = v ? 'PASS' : 'FAIL';
     if (skips[k]) {
         display = 'SKIP';
         results[k] = true; // skipped tests count as not failing the overall run
     }
     console.log(`${k.padEnd(12)}: ${display}`);
     if (!results[k]) allPass = false;
  }
  
  if (!allPass) {
     console.log('\n[Summary] 失败原因分析：');
     const fullText = collectedStrings.join('\n');
     if (fullText.includes('OAuth') || fullText.includes('authenticate')) {
         console.log('- claude 的 CLI 端登录已过期：请在终端手动跑一次 claude 登录后重试');
     } else if (fullText.includes('config.toml')) {
         console.log('- codex 的 ~/.codex/config.toml 有这个版本不认的取值，需用户自行修改，见 README');
     } else if (fullText.includes('permission') || fullText.includes('mcp(')) {
         console.log('- provider 拒绝了 MCP 工具调用：按 README『必做：agy 的权限配置』一节加 mcp(overlay-studio/<工具名>) 规则');
     } else {
         console.log('- 未识别的失败，用 OVERLAY_RUNNER_DEBUG=1 重跑看原始事件流');
     }
  }

  process.exitCode = allPass ? 0 : 1;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
