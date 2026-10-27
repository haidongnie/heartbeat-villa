import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Content-hashes every public media file so url() can append ?v=<hash> (safe to cache forever), and emits
 * dist/sw.js from sw/sw.js with this build's file lists baked in. No extra dependencies.
 */
function heartbeatAssets(): Plugin {
  const media: Record<string, [string, number]> = {};
  for (const dir of ['models', 'env', 'textures', 'portraits', 'fonts']) {
    const abs = join(root, 'public', dir);
    for (const f of readdirSync(abs)) {
      if (!statSync(join(abs, f)).isFile()) continue;
      const buf = readFileSync(join(abs, f));
      media[`${dir}/${f}`] = [createHash('sha256').update(buf).digest('hex').slice(0, 10), buf.length];
    }
  }
  const build = (process.env.GITHUB_SHA ?? Date.now().toString(36)).slice(0, 10);
  return {
    name: 'heartbeat-assets',
    enforce: 'post',
    config: () => ({ define: { __ASSETS__: JSON.stringify(media), __BUILD_ID__: JSON.stringify(build) } }),
    // The stylesheet link gets the same content-hash query as the other media (its woff2 urls carry theirs).
    transformIndexHtml: (html) => html.replace(/(fonts\/fonts\.css)(?=")/, `$1?v=${media['fonts/fonts.css']?.[0] ?? build}`),
    generateBundle(_options, bundle) {
      const shell = Object.keys(bundle).filter((f) => f.startsWith('assets/'));
      const manifest = { shell, media: Object.fromEntries(Object.entries(media).map(([p, [h]]) => [p, h])) };
      const source = readFileSync(join(root, 'sw/sw.js'), 'utf8')
        .replace('__BUILD_ID__', build)
        .replace('self.__SW_MANIFEST__', JSON.stringify(manifest));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// GitHub Pages serves the site from /<repo>/; override with BASE=/ for other hosts.
export default defineConfig({
  base: process.env.BASE ?? '/heartbeat-villa/',
  plugins: [heartbeatAssets()],
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 3000,
    rolldownOptions: {
      output: {
        // three.js in its own chunk: its hash survives game-code deploys, so returning players keep it cached.
        // SMAANode stays out of it so the dynamic import in renderer.ts really is a separate, parallel download.
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/](?!examples[\\/]jsm[\\/]tsl[\\/]display[\\/]SMAANode)/ }],
        },
      },
    },
  },
  server: { host: true },
});
