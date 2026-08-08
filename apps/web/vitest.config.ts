import { paraglideVitePlugin } from '@inlang/paraglide-js';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * Unit-test config for the web app.
 *
 * Deliberately separate from `vite.config.ts`: the app build also loads
 * Tailwind and sets a `base` from the Capacitor env var, neither of which a
 * jsdom test needs. Paraglide *is* loaded, because `src/paraglide` is generated
 * output and gitignored — without the plugin a fresh checkout has no `m.*` to
 * import.
 */
export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
    }),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    global: 'globalThis',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
