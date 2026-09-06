// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'

// `defineConfig` is invoked with `{ mode }` so we can call `loadEnv` and
// pick up variables from `frontend/.env.local` (gitignored) or `.env`.
// `process.env` is NOT automatically populated from these files when
// vite.config.ts is evaluated — this is a well-known Vite gotcha. Calling
// `loadEnv` explicitly makes VITE_* variables available inside the config.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
  // Vitest configuration for unit tests. Runs against src/**/*.test.ts.
  // See frontend/src/utils/*.test.ts for examples.
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The e2e Playwright suite lives in frontend/tests/e2e/ and is a
    // different test runner — exclude it from Vitest discovery.
    exclude: ['tests/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Scoped to the utils that have real logic worth unit testing.
      // The other utils files (datasyncApi.ts, dcvApi.ts, installScriptApi.ts,
      // storageApi.ts) are thin fetch wrappers with no branching worth
      // covering here — they're validated by the Playwright e2e suite.
      include: ['src/utils/api.ts', 'src/utils/auth.ts'],
    },
  },
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    global: 'globalThis',
  },
  // Strip console.log/debug/info from production builds by marking them as
  // pure (side-effect-free) so the minifier drops them. console.error and
  // console.warn are kept so real error signals still surface in production.
  // console.log in particular was leaking auth user objects (email, admin
  // flag, groups) and API URLs to the browser console.
  esbuild: {
    pure: ['console.log', 'console.debug', 'console.info'],
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@aws-sdk/client-cognito-identity-provider') || id.includes('@aws-sdk/client-ssm')) {
            return 'aws-sdk';
          }
          if (id.includes('@cloudscape-design/components') || id.includes('@cloudscape-design/global-styles')) {
            return 'cloudscape';
          }
          if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
            return 'react-vendor';
          }
        }
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    cors: true,
    hmr: {
      port: 3001,
      host: 'localhost'
    },
    // Dev-server proxy target for `/api/*` requests. Set VITE_API_URL in
    // a per-machine `frontend/.env.local` (see `.env.example`) to point at
    // your deployed MRM API Gateway. Falls back to a local loopback so
    // `npm run dev` doesn't crash when no deployment is configured.
    proxy: {
      '/api': {
        target: env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
  };
})
