import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }, // alias de Next
  },
  esbuild: { jsx: 'automatic' }, // los componentes .tsx importados en tests
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node', // default; los de render declaran jsdom por archivo
  },
});
