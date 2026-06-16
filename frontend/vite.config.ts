// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'

export default defineConfig({
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
        manualChunks: {
          'aws-sdk': ['@aws-sdk/client-cognito-identity-provider', '@aws-sdk/client-ssm'],
          'cloudscape': ['@cloudscape-design/components', '@cloudscape-design/global-styles'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom']
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
    proxy: {
      '/api': {
        target: 'https://0hk4rx8as8.execute-api.us-east-1.amazonaws.com/prod',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
})
