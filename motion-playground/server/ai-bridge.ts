import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function sendJson(res: ServerResponse, code: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export function aiBridge(): Plugin {
  let editorRes: ServerResponse | null = null;
  let nextCallId = 1;
  const pendingCalls = new Map<number, (result: any) => void>();
  const activeRuns = new Map<string, { abort: () => void, finished: boolean }>();

  return {
    name: 'ai-bridge',
    configureServer(server) {
      server.httpServer?.on('listening', () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr !== 'string') {
          const port = addr.port;
          const tmpDir = path.join(os.tmpdir(), 'overlay-studio');
          fs.mkdirSync(tmpDir, { recursive: true });
          fs.writeFileSync(path.join(tmpDir, 'port.json'), JSON.stringify({
            port,
            pid: process.pid,
            startedAt: Date.now()
          }));
        }
      });

      async function getRunner() {
        let runnerUrl;
        if (process.env.OVERLAY_AI_FAKE_RUNNER === '1') {
          runnerUrl = new URL('./test/fake-runner.mjs', import.meta.url).href;
        } else {
          const mod = process.env.OVERLAY_AI_RUNNER_MODULE || './runners/index.mjs';
          runnerUrl = new URL(mod, import.meta.url).href;
        }
        try {
          return await import(runnerUrl);
        } catch (e: any) {
          throw new Error(`Runner 尚未就绪或加载失败: ${e.message}`);
        }
      }

      server.middlewares.use('/api/ai/providers', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const runners = await getRunner();
          const list = await runners.listProviders();
          const { detectEngine } = await import(new URL('./stt.mjs', import.meta.url).href);
          const stt = await detectEngine();
          sendJson(res, 200, { ok: true, providers: list, stt });
        } catch (e: any) {
          sendJson(res, 503, { ok: false, error: String(e) });
        }
      });

      server.middlewares.use('/api/ai/chat', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          let hasDone = false;
          try {
            const runners = await getRunner();
            const data = JSON.parse(body);
            const { provider, prompt, sessionId, model, attachments } = data;
            
            let systemPrompt = '';
            try {
              systemPrompt = fs.readFileSync(new URL('./ai-system-prompt.md', import.meta.url), 'utf-8');
            } catch (e) {
              systemPrompt = 'System prompt missing.';
            }

            let finalPrompt = prompt;
            if (attachments && attachments.length > 0) {
              finalPrompt += '\n\n附件:\n' + attachments.map((a: any) => {
                let line = `- [${a.kind === 'video' ? '视频' : a.kind}] ${a.name} · 站内地址 ${a.url}`;
                if (a.url) {
                  const diskPath = path.join(server.config.root, 'public', decodeURIComponent(a.url.split('?')[0]));
                  if (diskPath.startsWith(path.join(server.config.root, 'public'))) {
                    line += ` · 磁盘路径 ${diskPath}`;
                  }
                }
                if (a.durationSec) line += ` · 时长 ${a.durationSec} 秒`;
                if (a.text) line += `\n\`\`\`\n${a.text}\n\`\`\``;
                return line;
              }).join('\n');
            }

            const editorPort = (server.httpServer?.address() as any)?.port || 5177;
            const editorState = editorRes ? "编辑台已连接" : "未连接";
            finalPrompt += `\n\n当前端口 ${editorPort};${editorState}`;

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            res.flushHeaders();

            const keepAlive = setInterval(() => {
              res.write(': ping\n\n');
            }, 15000);

            const mcp = {
              serverName: "overlay-studio",
              command: process.execPath,
              args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))],
              env: { OVERLAY_STUDIO_PORT: String(editorPort) }
            };

            const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
            fs.mkdirSync(cwd, { recursive: true });

            const runId = Math.random().toString(36).substring(2, 9);
            res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

            const run = runners.startRun({
              provider,
              prompt: finalPrompt,
              systemPrompt,
              sessionId,
              cwd,
              model,
              mcp,
              onEvent: (ev: any) => {
                if (ev.type === 'done') hasDone = true;
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
              }
            });

            const runState = { abort: run.abort, finished: false };
            activeRuns.set(runId, runState);

            req.on('close', () => {
              if (!runState.finished) run.abort();
              activeRuns.delete(runId);
              clearInterval(keepAlive);
            });

            try {
              await run.done;
            } catch (e: any) {
              if (!res.headersSent) throw e;
              res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
            }
            
            runState.finished = true;
            activeRuns.delete(runId);
            clearInterval(keepAlive);
            if (!hasDone) {
               res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            }
            res.end();
            
          } catch (e: any) {
            if (!res.headersSent) {
              sendJson(res, 503, { ok: false, error: String(e) });
            } else {
              res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
              res.end();
            }
          }
        });
      });

      server.middlewares.use('/api/ai/abort', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const { runId } = JSON.parse(body);
            const runState = activeRuns.get(runId);
            if (runState && !runState.finished) {
              runState.abort();
              runState.finished = true;
              activeRuns.delete(runId);
            }
            sendJson(res, 200, { ok: true });
          } catch(e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/events', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        
        if (editorRes) {
          editorRes.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
          editorRes.end();
        }
        
        editorRes = res;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.flushHeaders();
        
        const port = (server.httpServer?.address() as any)?.port || 5177;
        res.write(`data: ${JSON.stringify({ type: 'hello', port })}\n\n`);
        
        req.on('close', () => {
          if (editorRes === res) {
            editorRes = null;
          }
        });
      });

      server.middlewares.use('/api/mcp/result', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const cb = pendingCalls.get(data.id);
            if (cb) {
              cb(data);
              pendingCalls.delete(data.id);
            }
            sendJson(res, 200, { ok: true });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/call', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
          try {
            const { tool, args } = JSON.parse(body);
            const { tools } = await import(new URL('./mcp-tools.mjs', import.meta.url).href);
            const toolDef = tools.find((t: any) => t.name === tool);
            
            if (!toolDef) {
              return sendJson(res, 404, { ok: false, error: 'Unknown tool' });
            }

            if (toolDef.side === 'server' || toolDef.side === 'hybrid') {
              if (tool === 'transcribe_video') {
                const { transcribe } = await import(new URL('./stt.mjs', import.meta.url).href);
                const file = args.path || (args.url ? path.join(server.config.root, 'public', decodeURIComponent(args.url.split('?')[0])) : '');
                try {
                  const result = await transcribe(file, args.language);
                  sendJson(res, 200, { ok: true, result });
                } catch (e: any) {
                  sendJson(res, 200, { ok: false, error: String(e.message) });
                }
                return;
              } else if (tool === 'probe_media') {
                const { probeDuration } = await import(new URL('./stt.mjs', import.meta.url).href);
                const file = args.path || (args.url ? path.join(server.config.root, 'public', decodeURIComponent(args.url.split('?')[0])) : '');
                try {
                  const stat = fs.statSync(file);
                  const durationSec = await probeDuration(file);
                  sendJson(res, 200, { ok: true, result: { durationSec, sizeBytes: stat.size, path: file, url: args.url }});
                } catch (e: any) {
                  sendJson(res, 200, { ok: false, error: String(e.message) });
                }
                return;
              } else if (tool === 'get_card_authoring_guide') {
                try {
                  const markdown = fs.readFileSync(new URL('./card-authoring-guide.md', import.meta.url), 'utf-8');
                  sendJson(res, 200, { ok: true, result: { markdown } });
                } catch (e) {
                  sendJson(res, 200, { ok: false, error: '指南缺失' });
                }
                return;
              } else if (tool === 'import_video') {
                let file = args.path;
                let url = args.url;
                if (!file && !url) return sendJson(res, 200, { ok: false, error: 'Missing path or url' });
                
                const destDir = path.join(server.config.root, 'public', '_media');
                if (file) {
                  if (!file.startsWith(destDir)) {
                    const ext = path.extname(file);
                    const base = path.basename(file, ext);
                    const safe = base.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-80);
                    const destFile = path.join(destDir, `${safe}-${Date.now()}${ext}`);
                    fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(file, destFile);
                    url = `/_media/${encodeURIComponent(path.basename(destFile))}`;
                  } else {
                     url = `/_media/${encodeURIComponent(path.basename(file))}`;
                  }
                }
                
                if (!editorRes) return sendJson(res, 200, { ok: false, error: '编辑台没有打开:没有页面连着 /api/mcp/events' });
                
                const id = nextCallId++;
                const p = new Promise(resolve => {
                  pendingCalls.set(id, resolve);
                  setTimeout(() => {
                    if (pendingCalls.has(id)) {
                      pendingCalls.delete(id);
                      resolve({ ok: false, error: 'Timeout' });
                    }
                  }, 60000);
                });
                
                editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool: 'register_video', args: { url, name: args.name, setAs: args.set_as } })}\n\n`);
                const out: any = await p;
                return sendJson(res, 200, out);
              }
            }

            if (!editorRes) {
              return sendJson(res, 200, { ok: false, error: '编辑台没有打开:没有页面连着 /api/mcp/events' });
            }

            const id = nextCallId++;
            const p = new Promise(resolve => {
              pendingCalls.set(id, resolve);
              // Server tools timeout is 30 mins (transcribe_video is server, handled above)
              // This branch is for browser side tools, timeout 60 seconds
              const isTranscribe = tool === 'transcribe_video'; // (never hit here, just to be sure)
              const timeout = isTranscribe ? 1800000 : 60000;
              setTimeout(() => {
                if (pendingCalls.has(id)) {
                  pendingCalls.delete(id);
                  resolve({ ok: false, error: 'Timeout' });
                }
              }, timeout);
            });

            editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool, args })}\n\n`);
            
            const out: any = await p;
            sendJson(res, 200, out);
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: String(e) });
          }
        });
      });

      server.middlewares.use('/api/mcp/status', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const port = (server.httpServer?.address() as any)?.port || 5177;
        sendJson(res, 200, {
          editorConnected: !!editorRes,
          pending: pendingCalls.size,
          port
        });
      });
    }
  };
}
