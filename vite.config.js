import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Stamp the service worker cache name with a per-build ID so every deploy gets a
// fresh cache and the SW's activate() purges the previous one. No human ever
// hand-bumps a cache version, so the changelog/shell can't go stale after a
// deploy. The ID is unique per build (timestamp + random), no git state needed.
function stampServiceWorker() {
  const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    // publicDir files are copied to the outDir; rewrite the on-disk sw.js after
    // the build so __SW_BUILD_ID__ becomes a unique per-build cache name.
    async closeBundle() {
      const { readFile, writeFile } = await import('node:fs/promises');
      const path = 'app/dist/sw.js';
      try {
        const src = await readFile(path, 'utf8');
        if (src.includes('__SW_BUILD_ID__')) {
          await writeFile(path, src.replaceAll('__SW_BUILD_ID__', buildId));
        }
      } catch { /* sw.js not emitted; nothing to stamp */ }
    },
  };
}

export default defineConfig({
  root: 'app',
  publicDir: 'public',
  plugins: [svelte(), stampServiceWorker()],
  build: { outDir: 'dist', emptyOutDir: true },
});
