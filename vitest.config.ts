import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
  plugins: [
    // esbuild (el transform default de vitest) no emite decorator metadata,
    // y sin design:paramtypes la DI de Nest no puede inyectar constructores
    // en los tests e2e. SWC sí la emite.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
});
