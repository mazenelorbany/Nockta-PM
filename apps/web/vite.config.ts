import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';

// =============================================================================
// Vite config.
//
// Round 7 Pass G added two performance affordances:
//
//   1. `pnpm build:analyze` — runs the production build with the optional
//      rollup-plugin-visualizer. The plugin is loaded via createRequire so
//      the default dev/build paths don't error out if it isn't installed;
//      we print a friendly hint to install it on demand instead.
//
//   2. `build.chunkSizeWarningLimit: 600` (kB). The default is 500 which we
//      were just over on the project board chunk; 600 keeps the warning
//      tight enough to catch real regressions while skipping the noise for
//      our current Tiptap-loaded page.
// =============================================================================

const ANALYZE = process.env.ANALYZE === 'true';

// Optional plugin — only required when ANALYZE=true. Using createRequire +
// try/catch yields a synchronous resolve (so we don't need top-level await
// in vite.config) AND degrades gracefully if the package isn't installed.
const require = createRequire(import.meta.url);
let visualizerPlugin: PluginOption | null = null;
if (ANALYZE) {
  try {
    const mod = require('rollup-plugin-visualizer') as {
      visualizer: (opts: Record<string, unknown>) => PluginOption;
    };
    visualizerPlugin = mod.visualizer({
      filename: 'dist/bundle-stats.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
      open: true,
    });
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '[vite] ANALYZE=true but rollup-plugin-visualizer is not installed.',
      'Run: pnpm add -D rollup-plugin-visualizer',
    );
  }
}

export default defineConfig({
  plugins: [react(), ...(visualizerPlugin ? [visualizerPlugin] : [])],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Warn when any chunk crosses 600 kB un-minified. Default is 500; we
    // raised it once after rolling Tiptap into the docs page.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Explicit vendor splits. Without this, Rollup's automatic chunking
        // can pile React + router + query into the same async chunk as a
        // route module, defeating long-term browser caching. The split
        // below keeps the framework cores in their own chunks that change
        // only on dep upgrades, so a feature ship doesn't bust the React
        // chunk's cache.
        //
        //   react-vendor   — react + react-dom + jsx runtime
        //   router         — react-router-dom
        //   query          — @tanstack/react-query
        //   dnd            — @dnd-kit/* (heavy, only board + backlog + timeline)
        //   tiptap         — @tiptap/* (only the docs page)
        //   recharts       — only the analytics page
        //
        // socket.io-client is already in its own chunk via the dynamic
        // import in lib/socket.ts — no manualChunk entry needed.
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor';
          }
          if (id.includes('node_modules/react-router-dom/')) return 'router';
          if (id.includes('node_modules/@tanstack/react-query/')) return 'query';
          if (id.includes('node_modules/@dnd-kit/')) return 'dnd';
          if (id.includes('node_modules/@tiptap/')) return 'tiptap';
          if (id.includes('node_modules/recharts/')) return 'recharts';
          return null;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@nockta/types': path.resolve(__dirname, '../../packages/types/src'),
      '@nockta/sdk': path.resolve(__dirname, '../../packages/sdk/src'),
      '@nockta/ui': path.resolve(__dirname, '../../packages/ui/src'),
    },
  },
});
