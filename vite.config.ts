// -*- coding: utf-8 -*-
/**
 * vite.config.ts
 * Mobile Interface Build Configuration
 * =====================
 * Configures the React interface and development preview.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.tools/**', '**/.cache/**', '**/upstream/**', '**/native/runtime/target/**', '**/android/**', '**/ios/**'] },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
