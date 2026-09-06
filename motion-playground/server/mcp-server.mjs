import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { tools } from './mcp-tools.mjs';

function getPort() {
  if (process.env.OVERLAY_STUDIO_PORT) {
    return parseInt(process.env.OVERLAY_STUDIO_PORT, 10);
  }
  try {
    const p = path.join(os.tmpdir(), 'overlay-studio', 'port.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return data.port || 5177;
    }
  } catch (e) {
    // ignore
  }
  return 5177;
}

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + '\n');
}

async function handleMessage(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    return; // ignore invalid json
  }
  
  if (!req.method) return; // ignore non-requests
  if (req.method === 'notifications/initialized') return; // ignore

  if (req.method === 'initialize') {
    let clientProtocolVersion = (req.params && req.params.protocolVersion) || "2025-03-26";
    if (clientProtocolVersion !== "2025-03-26") {
      clientProtocolVersion = "2025-03-26";
    }
    sendResponse(req.id, {
      protocolVersion: clientProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "overlay-studio", version: "0.1.0" }
    });
    return;
  }

  if (req.method === 'ping') {
    sendResponse(req.id, {});
    return;
  }

  if (req.method === 'tools/list') {
    const pubTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
    sendResponse(req.id, { tools: pubTools });
    return;
  }

  if (req.method === 'tools/call') {
    const tool = req.params.name;
    const args = req.params.arguments || {};
    const port = getPort();
    
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/mcp/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args })
      });
    } catch (e) {
      sendResponse(req.id, {
        content: [{ type: "text", text: "Overlay Studio 没在运行(端口 " + port + " 没有服务)" }],
        isError: true
      });
      return;
    }
      
    if (!res.ok) {
      const text = await res.text();
      sendResponse(req.id, {
        content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }],
        isError: true
      });
      return;
    }
    
    const out = await res.json();
    if (out.ok) {
      sendResponse(req.id, {
        content: [{ type: "text", text: JSON.stringify(out.result || out, null, 2) }]
      });
    } else {
      sendResponse(req.id, {
        content: [{ type: "text", text: out.error || "Unknown error" }],
        isError: true
      });
    }
    return;
  }

  if (req.id !== undefined) {
    sendError(req.id, -32601, "Method not found");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  handleMessage(line).catch(e => {
    process.stderr.write(`Error handling message: ${e.message}\n`);
  });
});
