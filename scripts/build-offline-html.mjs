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

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0b0f14"/>
  <circle cx="256" cy="256" r="176" fill="#12b886"/>
  <path d="M132 162c64 46 64 142 0 188M380 162c-64 46-64 142 0 188" fill="none" stroke="#0b0f14" stroke-width="26" stroke-linecap="round"/>
  <text x="256" y="284" text-anchor="middle" font-family="system-ui,sans-serif" font-size="112" font-weight="900" fill="#0b0f14">40</text>
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
    background_color: '#0b0f14',
    theme_color: '#0b0f14',
    icons: [
      {
        src: './icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable',
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
  <meta name="theme-color" content="#0b0f14">
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
