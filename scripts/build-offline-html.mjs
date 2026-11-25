import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const entrySource = `
import { runSharedFixture } from './src/core/sharedFixture.js';
const target = document.getElementById('fixture-out');
if (target) {
  target.textContent = runSharedFixture();
}
`;

const built = await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: process.cwd(),
    loader: 'js',
    sourcefile: 'offline-fixture-entry.js',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
});

const jsBundle = built.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PadelScore — Band 9 Active PWA</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; padding: 24px; }
    pre { font-size: 32px; font-weight: bold; color: #00ff66; background: #000; padding: 16px; display: inline-block; border: 1px solid #333; }
  </style>
</head>
<body>
  <h1>PadelScore — Shared Pure-JS Fixture</h1>
  <p>Expected value: <code>30-15</code></p>
  <pre id="fixture-out"></pre>
  <script>
${jsBundle}
  </script>
</body>
</html>
`;

const outDir = path.resolve('dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'index.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(`Built static PWA entry: dist/index.html (${Buffer.byteLength(html, 'utf8')} bytes)`);
