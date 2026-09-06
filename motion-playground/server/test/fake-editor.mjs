import * as http from 'node:http';

const port = process.env.OVERLAY_STUDIO_PORT || 5196;

const req = http.request(`http://127.0.0.1:${port}/api/mcp/events`, {
  method: 'GET',
  headers: {
    'Accept': 'text/event-stream'
  }
}, (res) => {
  let buffer = '';
  res.on('data', (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    
    for (const part of parts) {
      if (part.startsWith('data: ')) {
        try {
          const ev = JSON.parse(part.slice(6));
          if (ev.type === 'hello') {
            console.log('READY');
          } else if (ev.type === 'replaced') {
            console.log('[fake-editor] replaced, exiting');
            process.exit(0);
          } else if (ev.type === 'call') {
            console.log('[fake-editor] handling call:', ev.tool);
            let result = {};
            if (ev.tool === 'get_editor_state') {
              result = { curT: 0, duration: 10, cards: [] };
            }
            
            const body = JSON.stringify({
              id: ev.id,
              ok: true,
              result
            });
            const pReq = http.request(`http://127.0.0.1:${port}/api/mcp/result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            pReq.write(body);
            pReq.end();
          }
        } catch {
          // ignore parsing error
        }
      }
    }
  });
});

req.on('error', (e) => {
  console.error('[fake-editor] error', e);
});
req.end();
