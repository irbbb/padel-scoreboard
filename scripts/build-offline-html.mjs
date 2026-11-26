import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const outDir = path.resolve('dist');
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.resolve('src/app/main.js')],
  outfile: path.join(outDir, 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
});

fs.copyFileSync(path.resolve('src/app/styles.css'), path.join(outDir, 'styles.css'));

// Maskable-safe icon: inner card & all glyphs sit strictly inside central 80% safe circle (r=204.8px; 144*sqrt(2)=203.6px)
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#111318"/>
  <rect x="112" y="112" width="288" height="288" rx="44" fill="#191c22" stroke="#2d323c" stroke-width="10"/>
  <rect x="142" y="158" width="24" height="24" rx="6" fill="#4cc39a"/>
  <circle cx="192" cy="170" r="12" fill="#d9ea4e"/>
  <text x="368" y="192" text-anchor="end" font-family="system-ui,sans-serif" font-size="76" font-weight="900" fill="#f2f4f7">40</text>
  <line x1="142" y1="256" x2="370" y2="256" stroke="#2d323c" stroke-width="7"/>
  <rect x="142" y="318" width="24" height="24" rx="6" fill="#6ba4e8"/>
  <text x="368" y="352" text-anchor="end" font-family="system-ui,sans-serif" font-size="76" font-weight="900" fill="#9aa3b2">15</text>
</svg>
`;
fs.writeFileSync(path.join(outDir, 'icon.svg'), iconSvg, 'utf8');

const manifestJson = JSON.stringify(
  {
    name: 'PadelScore — Band 9 Active',
    short_name: 'PadelScore',
    description: 'Offline padel scoreboard & personal Unforced Error tracker for Xiaomi Smart Band 9 Active.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#111318',
    theme_color: '#111318',
    icons: [
      {
        src: './icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: './icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  },
  null,
  2
);
fs.writeFileSync(path.join(outDir, 'manifest.webmanifest'), `${manifestJson}\n`, 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#111318">
  <title>PadelScore — Band 9 Active PWA</title>
  <link rel="manifest" href="./manifest.webmanifest">
  <link rel="icon" href="./icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main id="app">
    <noscript>JavaScript is required to run PadelScore.</noscript>
  </main>
  <script src="./app.js" defer></script>
</body>
</html>
`;
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

const appJsBuf = fs.readFileSync(path.join(outDir, 'app.js'));
const stylesBuf = fs.readFileSync(path.join(outDir, 'styles.css'));
const buildHash = crypto
  .createHash('sha256')
  .update(html)
  .update(appJsBuf)
  .update(stylesBuf)
  .update(manifestJson)
  .update(iconSvg)
  .digest('hex')
  .slice(0, 10);

const swSource = `const CACHE_NAME = 'padelscore-shell-${buildHash}';
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  // Never call skipWaiting() automatically so an active match is never reloaded mid-match
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'SKIP_WAITING') return;
  const reply = (payload) => {
    try {
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage(payload);
      } else if (event.source && typeof event.source.postMessage === 'function') {
        event.source.postMessage(payload);
      }
    } catch {
      // Ignore reply port errors
    }
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Waiting worker does not yet control existing v1 tabs, so we MUST inspect uncontrolled
      // windows filtered to this registration scope and only proceed if requester is the sole window.
      const scope = self.registration.scope;
      const scopeNoSlash = scope.endsWith('/') ? scope.slice(0, -1) : scope;
      const inScope = clientList.filter(
        (c) => typeof c.url === 'string' && (c.url === scopeNoSlash || c.url.startsWith(scope))
      );
      const requesterId = event.source && typeof event.source.id === 'string' ? event.source.id : null;
      const hasOtherWindow =
        inScope.length > 1 ||
        (requesterId !== null && inScope.some((c) => c.id !== requesterId));

      if (hasOtherWindow) {
        reply({ ok: false, reason: 'other_window_open' });
        return undefined;
      }
      reply({ ok: true });
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('padelscore-shell-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return undefined;
      });
    })
  );
});
`;
fs.writeFileSync(path.join(outDir, 'sw.js'), swSource, 'utf8');

console.log(
  `Built static PWA bundle (${buildHash}): dist/index.html (${Buffer.byteLength(html, 'utf8')} B), dist/app.js (${appJsBuf.byteLength} B), dist/styles.css (${stylesBuf.byteLength} B), manifest.webmanifest, sw.js`
);
