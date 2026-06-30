import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  root: 'app',
  publicDir: 'public',
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
});
