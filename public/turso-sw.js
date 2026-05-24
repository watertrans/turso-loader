/**
 * turso-sw.js — Generic Service Worker for Turso WASM apps.
 *
 * Responsibilities:
 *  1. Pre-cache the app shell (HTML, JS) on install so the app loads offline.
 *  2. Cache WASM bundles on first fetch so they are not re-downloaded on reload.
 *  3. Serve all cached assets cache-first to minimise network round-trips.
 *  4. Handle an UPDATE message from the page to force-refresh the cache
 *     when a new WASM version is deployed.
 *
 * Register from the page with URL parameters to configure behaviour:
 *
 *   navigator.serviceWorker.register('/turso-sw.js?shell=/demo.html,/turso-db.js&wasm=/turso-wasm/', { scope: '/' });
 *
 * URL parameters:
 *   shell  - Comma-separated list of URLs to pre-cache at install time.
 *            These are fetched immediately so the app works on the next load
 *            even without a network connection.
 *   wasm   - URL substring used to identify WASM fetch requests that should be
 *            cached on first use. Default: '/turso-wasm/'
 *   cache  - Cache Storage bucket name. Change this to bust the entire cache
 *            (old buckets are deleted during activate). Default: 'turso-v1'
 *
 * Sending an UPDATE message from the page:
 *
 *   const reg = await navigator.serviceWorker.ready;
 *   reg.active.postMessage({ type: 'UPDATE' });
 *   navigator.serviceWorker.addEventListener('message', e => {
 *     if (e.data.type === 'UPDATE_DONE')  console.log('cache refreshed');
 *     if (e.data.type === 'UPDATE_ERROR') console.error(e.data.message);
 *   });
 */

// Read configuration from the query string baked into the registration URL.
// Splitting on commas lets callers pass multiple shell URLs as a single parameter.
const params       = new URLSearchParams(self.location.search);
const APP_SHELL    = params.get('shell')?.split(',').filter(Boolean) ?? [];
const WASM_PATTERN = params.get('wasm')  ?? '/turso-wasm/';
const CACHE        = params.get('cache') ?? 'turso-v1';

/**
 * install — pre-cache the app shell so it is available before the first fetch.
 *
 * skipWaiting() makes this worker take control immediately without waiting for
 * existing tabs to close, which is safe here because the cache name is versioned.
 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

/**
 * activate — delete any Cache Storage buckets whose name no longer matches CACHE.
 *
 * This cleans up stale caches left behind by previous service worker versions
 * (e.g. 'turso-v1' → 'turso-v2' after a cache-busting rename).
 * clients.claim() makes this worker the controller for all open tabs immediately
 * so the new cache strategy takes effect without requiring a page reload.
 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/**
 * fetch — cache-first strategy.
 *
 * - Only GET requests are handled; other methods (POST, etc.) pass through.
 * - If the asset is already in the cache, it is returned immediately without
 *   hitting the network. This keeps WASM loads instant on repeat visits.
 * - On a cache miss the request goes to the network. WASM responses (identified
 *   by WASM_PATTERN in the URL) are written into the cache so subsequent loads
 *   are served locally. Non-WASM responses are returned as-is without caching
 *   to avoid growing the cache with assets that change frequently.
 */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(async cached => {
      let response;
      if (cached) {
        response = cached;
      } else {
        response = await fetch(event.request);
        // Cache WASM bundles on first fetch. response.clone() is required because
        // a Response body can only be consumed once — one copy goes to the cache,
        // the other is returned to the page.
        if (response.ok && event.request.url.includes(WASM_PATTERN)) {
          caches.open(CACHE).then(c => c.put(event.request, response.clone()));
        }
      }
      // Inject COOP/COEP so SharedArrayBuffer is available on hosts that cannot
      // set HTTP headers (e.g. GitHub Pages). No-op when the server already sends
      // these headers — the browser uses the SW response headers for cached resources.
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy',  'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    })
  );
});

/**
 * message — handle UPDATE requests from the page.
 *
 * Forces a fresh download of all WASM files and app shell assets, bypassing
 * both the Cache Storage and the browser's HTTP cache ({ cache: 'reload' }).
 * Use this when deploying a new WASM version so users get the update without
 * having to clear their browser cache manually.
 *
 * On success  → posts { type: 'UPDATE_DONE' } back to the requesting tab.
 * On failure  → posts { type: 'UPDATE_ERROR', message } back to the requesting tab.
 */
self.addEventListener('message', async event => {
  if (event.data?.type !== 'UPDATE') return;
  const client = event.source;
  try {
    const cache    = await caches.open(CACHE);
    const keys     = await cache.keys();
    // Collect all cached WASM entries so they can be deleted and re-fetched.
    const wasmKeys = keys.filter(r => r.url.includes(WASM_PATTERN));

    // Delete stale WASM entries before re-fetching so an interrupted update
    // does not leave a mix of old and new files in the cache.
    await Promise.all(wasmKeys.map(k => cache.delete(k)));

    // Re-fetch app shell and WASM in parallel. { cache: 'reload' } bypasses the
    // browser's HTTP cache so we always get the latest version from the server.
    await Promise.all([
      ...APP_SHELL.map(async url => {
        const res = await fetch(url, { cache: 'reload' });
        await cache.put(url, res);
      }),
      ...wasmKeys.map(async key => {
        const res = await fetch(key.url, { cache: 'reload' });
        await cache.put(key.url, res);
      }),
    ]);

    client.postMessage({ type: 'UPDATE_DONE' });
  } catch (err) {
    client.postMessage({ type: 'UPDATE_ERROR', message: err.message });
  }
});
