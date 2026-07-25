import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Docs/demo site lives in site/; build output goes to site/dist. The demo runs
// the in-memory PulseRouter directly in the browser, so no API server is needed
// to dogfood subscribe/emit/claim/ack.
export default defineConfig({
  root: 'site',
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
});
