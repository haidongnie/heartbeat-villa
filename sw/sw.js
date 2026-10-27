/* Heartbeat Villa service worker.
 * Source: sw/sw.js. vite.config.ts (heartbeatAssets plugin) fills in BUILD and MANIFEST and emits dist/sw.js.
 *
 * Only immutable URLs are served cache-first:
 *   <base>assets/*                                   Vite output, content-hashed file names
 *   <base>{models,env,textures,portraits}/*?v=<hash> public files, url() appends the content hash
 *   <base>fonts/*?v=<hash>                             fonts.css link and its woff2 urls carry content hashes
 * Pages under the scope are fetched network-first with revalidation, so an HTML file never outlives the build
 * whose chunks it references. Everything else (sw.js, unversioned URLs, every cross-origin request such as
 * Playroom) is not intercepted, so the browser's normal network + HTTP cache behaviour applies.
 */
const BUILD = '__BUILD_ID__';
const MANIFEST = self.__SW_MANIFEST__; // { shell: string[], media: Record<string, string> }

// haidongnie.github.io is one origin shared by every repository's Pages site, so Cache Storage is shared too:
// only ever touch caches with this prefix.
const PREFIX = 'heartbeat-villa:';
const CACHE = `${PREFIX}immutable-v1`;
const BASE = new URL('./', self.location.href).pathname; // '/heartbeat-villa/' (or '/' when built with BASE=/)
const MEDIA = /^(models|env|textures|portraits|fonts)\//;

function isImmutable(url) {
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return false;
  const rel = url.pathname.slice(BASE.length);
  return rel.startsWith('assets/') || (MEDIA.test(rel) && url.searchParams.has('v'));
}

function cacheable(res) {
  return res.status === 200 && res.type === 'basic' && !res.redirected;
}

/** Every URL this build may cache (computed once: the manifest is baked into this file). */
let KEEP;
function keepSet() {
  if (KEEP) return KEEP;
  const keep = new Set(MANIFEST.shell.map((f) => BASE + f));
  for (const [p, v] of Object.entries(MANIFEST.media)) keep.add(`${BASE}${p}?v=${v}`);
  KEEP = keep;
  return keep;
}

self.addEventListener('install', () => {
  // Nothing is precached here: on a first visit the page is already downloading the same files, and the
  // 'warm' message below copies them from the HTTP cache afterwards. No skipWaiting(): an updated worker
  // waits until tabs of the previous build are gone, so pruning in 'activate' never removes a file that an
  // old tab may still lazy-load (for example the Playroom chunk).
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    const keep = keepSet();
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (!keep.has(u.pathname + u.search)) await cache.delete(req);
    }
    // First install: take control of the open page so the rest of its downloads are cached on the way in.
    await self.clients.claim();
  })());
});

async function cacheFirst(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  // Store only complete same-origin 200s (never 206 partial content, opaque or error responses). The put runs
  // in waitUntil so the page streams the body (and gets progress events) while the copy is written.
  // Only store URLs of this build: GitHub Pages ignores ?v=, so an unknown hash may carry a different file.
  const u = new URL(req.url);
  if (cacheable(res) && keepSet().has(u.pathname + u.search)) {
    event.waitUntil(cache.put(req.url, res.clone()).catch(() => { /* quota or private mode: still serve it */ }));
  }
  return res;
}

// GitHub Pages lets browsers reuse index.html for 10 minutes; after a deploy that page could reference chunks the
// new worker already pruned. Revalidate navigations (a cheap 304 when nothing changed).
async function freshPage(req) {
  try {
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (!res.redirected) return res;
  } catch { /* offline: let the browser try */ }
  return fetch(req);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.origin === self.location.origin && url.pathname.startsWith(BASE)) event.respondWith(freshPage(req));
    return;
  }
  if (req.headers.has('range')) return; // range requests go straight to the network
  if (isImmutable(url)) event.respondWith(cacheFirst(event).catch(() => fetch(req)));
});

// The page posts { type: 'warm', urls } once everything has loaded. Files fetched before this worker took
// control are copied into the cache; within GitHub Pages' max-age=600 they come from the HTTP cache, not the network.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const keep = keepSet();
    for (const href of data.urls) {
      let url;
      try { url = new URL(href, self.location.href); } catch { continue; }
      if (!isImmutable(url) || !keep.has(url.pathname + url.search)) continue;
      if (await cache.match(url.href, { ignoreVary: true })) continue;
      try {
        const res = await fetch(url.href, { credentials: 'same-origin' });
        if (cacheable(res)) await cache.put(url.href, res);
      } catch (e) { /* offline or quota: try again next visit */ }
    }
  })());
});

void BUILD;
