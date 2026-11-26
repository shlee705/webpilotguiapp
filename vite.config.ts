import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// PDF fonts, CMaps and image decoders ship with the app; viewing needs no CDN.
function pdfAssets(): Plugin {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const directories = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  return {
    name: 'local-pdf-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([a-zA-Z0-9_.-]+)$/.exec((request.url ?? '').split('?')[0]);
        if (!match || match[2] === '.' || match[2] === '..') return next();
        try {
          response.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
          response.end(readFileSync(path.join(root, match[1], match[2])));
        } catch { next(); }
      });
    },
    generateBundle() {
      for (const directory of directories) for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (entry.isFile()) this.emitFile({ type: 'asset', fileName: `pdfjs/${directory}/${entry.name}`, source: readFileSync(path.join(root, directory, entry.name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfAssets()],
  base: './',
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    // Bundled browsers and publish checkouts are not renderer inputs. Watching
    // their locked binaries can prevent the Windows development server starting.
    watch: { ignored: ['**/release/**', '**/artifacts/**', '**/webtestpilot-backend/**'] },
  },
});
