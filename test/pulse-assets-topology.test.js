// PROD TOPOLOGY REGRESSION (Dane BLOCK fix) — pulse routes must reach the worker
// through the SPA asset layer, not be swallowed by the single-page-application
// not_found fallback.
//
// THE BUG: wrangler.jsonc configures
//   assets.not_found_handling = "single-page-application"
//   assets.run_worker_first   = [...]  (the worker-first allow-list)
// In PRODUCTION, any path NOT in run_worker_first and with no matching asset is
// served index.html (HTTP 200) by the asset layer and NEVER reaches the worker.
// The pulse routes /pulse,/claim,/ack,/status had NO asset files and were NOT in
// run_worker_first, so prod served them index.html and the token gate never ran.
//
// Every prior pulse test booted src/pulse/worker.js standalone in Miniflare WITHOUT
// the assets binding, so the SPA layer wasn't in the path — the bug was invisible.
//
// This test boots the FULL control worker (src/control-worker.js, the prod entry)
// in Miniflare WITH the assets binding configured exactly like prod:
//   - not_found_handling: single-page-application
//   - static_routing.user_worker = the run_worker_first list from wrangler.jsonc
//     (Miniflare's static_routing.user_worker is the run_worker_first equivalent)
//   - a fixture assets dir whose index.html is the SPA fallback body
//
// It asserts:
//   - GET/POST to /pulse,/claim,/ack,/status REACH the worker: without a token
//     they return 401 JSON (the token gate ran), NOT 200 index.html.
//   - an unknown route /definitely-not-a-route still gets the SPA index.html
//     fallback (200, the html body) — proving we did not over-route.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Distinctive SPA fallback body so we can tell "asset layer served it" apart
// from "worker handled it".
const SPA_MARKER = '<!-- SPA-FIXTURE-INDEX terrarium pulse-assets-topology -->';
const SPA_HTML = `<!doctype html><html><head><title>spa</title></head><body>${SPA_MARKER}</body></html>`;

// Pull the run_worker_first list straight from the shipped wrangler.jsonc so the
// test routes exactly what prod routes (and fails if someone drops a pulse entry).
function runWorkerFirstFromWrangler() {
  const raw = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  // strip // line comments (jsonc) then parse
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  const cfg = JSON.parse(stripped);
  return cfg.assets.run_worker_first;
}

function makeFixtureAssetsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-assets-fixture-'));
  writeFileSync(join(dir, 'index.html'), SPA_HTML, 'utf8');
  return dir;
}

function makeMf(assetsDir, userWorkerGlobs) {
  return new Miniflare({
    scriptPath: join(root, 'src/control-worker.js'),
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-06-05',
    // PROD entry has these bindings; provide them so the worker boots and runs.
    durableObjects: {
      PULSE_ROUTER: { className: 'PulseRouter', useSQLite: true },
      CAMPAIGN_LOCK: { className: 'CampaignLock', useSQLite: true },
    },
    bindings: { TERRARIUM_MODE: 'fixture' /* no PULSE_TOKEN => fail-closed 401 */ },
    // The asset layer, configured exactly like prod.
    assets: {
      directory: assetsDir,
      binding: 'APP_ASSETS',
      assetConfig: { not_found_handling: 'single-page-application' },
      routerConfig: {
        has_user_worker: true,
        // static_routing.user_worker is Miniflare's run_worker_first equivalent:
        // paths matching these globs hit the worker BEFORE the asset layer.
        static_routing: { user_worker: userWorkerGlobs },
      },
    },
  });
}

async function fetchRaw(mf, method, path) {
  const res = await mf.dispatchFetch(`https://terrarium.local${path}`, { method });
  const text = await res.text();
  return { status: res.status, text, ctype: res.headers.get('content-type') || '' };
}

const PULSE_ROUTES = [
  { method: 'POST', path: '/pulse' },
  { method: 'POST', path: '/claim' },
  { method: 'POST', path: '/ack' },
  { method: 'GET', path: '/status' },
];

test('prod topology: pulse routes reach the worker (401 token gate), not the SPA fallback', async () => {
  const assetsDir = makeFixtureAssetsDir();
  const mf = makeMf(assetsDir, runWorkerFirstFromWrangler());
  try {
    for (const { method, path } of PULSE_ROUTES) {
      const r = await fetchRaw(mf, method, path);
      // Reached the worker + token gate (no PULSE_TOKEN configured => fail-closed).
      assert.equal(r.status, 401, `${method} ${path} should hit the worker and 401, got ${r.status}: ${r.text.slice(0, 120)}`);
      assert.match(r.ctype, /application\/json/, `${method} ${path} must be JSON from the worker, not html`);
      const body = JSON.parse(r.text);
      assert.equal(body.ok, false, `${method} ${path} worker body should be the 401 JSON`);
      // Hard proof it was NOT the SPA fallback.
      assert.ok(!r.text.includes(SPA_MARKER), `${method} ${path} must NOT be served the SPA index.html`);
    }
  } finally {
    await mf.dispose();
    rmSync(assetsDir, { recursive: true, force: true });
  }
});

test('prod topology: an unknown route still gets the SPA index.html fallback (not over-routed)', async () => {
  const assetsDir = makeFixtureAssetsDir();
  const mf = makeMf(assetsDir, runWorkerFirstFromWrangler());
  try {
    const r = await fetchRaw(mf, 'GET', '/definitely-not-a-route');
    assert.equal(r.status, 200, `unknown route should get SPA 200, got ${r.status}: ${r.text.slice(0, 120)}`);
    assert.ok(r.text.includes(SPA_MARKER), 'unknown route must be served the SPA index.html fallback');
  } finally {
    await mf.dispose();
    rmSync(assetsDir, { recursive: true, force: true });
  }
});

test('regression guard: wrangler.jsonc run_worker_first includes every pulse route', () => {
  const list = runWorkerFirstFromWrangler();
  for (const p of ['/pulse', '/claim', '/ack', '/status']) {
    assert.ok(list.includes(p), `wrangler.jsonc assets.run_worker_first must include ${p} (prod would SPA-swallow it otherwise)`);
  }
});
