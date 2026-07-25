#!/usr/bin/env node
// Minimal Pulse CLI for poking a running server. Reads PULSE_URL (default
// http://127.0.0.1:8788) and PULSE_TOKEN (default local-dev).
//
//   pulse health
//   pulse subscribe '{"subscriberId":"docs","channels":["docs"]}'
//   pulse emit '{"type":"Completed","runId":"r1","at":"...","channel":"docs"}'
//   pulse claim '{"subscriberId":"docs"}'
//   pulse ack '{"subscriberId":"docs","eventId":"evt_..."}'
//   pulse status docs

const base = process.env.PULSE_URL || 'http://127.0.0.1:8788';
const token = process.env.PULSE_TOKEN || 'local-dev';
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let res;
  switch (cmd) {
    case 'health': res = await fetch(`${base}/health`); break;
    case 'subscribe': res = await post('/pulse', { action: 'subscribe', ...JSON.parse(arg) }); break;
    case 'emit':
    case 'route': res = await post('/pulse', { action: 'route', event: JSON.parse(arg) }); break;
    case 'claim': res = await post('/claim', JSON.parse(arg)); break;
    case 'ack': res = await post('/ack', JSON.parse(arg)); break;
    case 'status': res = await fetch(`${base}/status?subscriberId=${encodeURIComponent(arg)}`, { headers }); break;
    default:
      console.error('usage: pulse <health|subscribe|emit|claim|ack|status> [json|id]');
      process.exit(2);
  }
  const text = await res.text();
  console.log(text);
  if (!res.ok) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
