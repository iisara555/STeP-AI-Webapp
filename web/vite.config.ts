import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'private-safe-app-shell',
      generateBundle(_, bundle) {
        const shell = [
          '/',
          '/index.html',
          '/icon.svg',
          '/icon-192.png',
          '/icon-512.png',
          '/icon-180.png',
          '/manifest.webmanifest',
          '/theme.js',
          '/step-symbol-colour.svg',
          '/step-symbol-mono-white.svg',
          ...Object.keys(bundle)
            .filter((n) => /\.(js|css|woff2)$/.test(n))
            .map((n) => '/' + n),
        ];
        const template = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8');
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: template
            .replace('__APP_SHELL__', JSON.stringify(shell))
            .replace(
              '__CACHE_VERSION__',
              createHash('sha256').update(JSON.stringify(shell)).digest('hex').slice(0, 16),
            ),
        });
      },
    },
  ],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('pdfjs-dist')) return 'pdf-tools';
          if (id.includes('node_modules/docx/')) return 'word-export';
        },
      },
    },
  },
});
