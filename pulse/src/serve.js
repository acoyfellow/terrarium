// Node entrypoint: serve the Hono app on a local port via @hono/node-server.
// PORT and PULSE_TOKEN come from the environment. This file is Node-only; the
// Worker entry is the default export of ./server.js.

import { serve } from '@hono/node-server';
import app from './server.js';

const port = Number(process.env.PORT) || 8788;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pulse listening on http://127.0.0.1:${info.port}`);
});
