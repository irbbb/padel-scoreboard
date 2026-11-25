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

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0b0f14">
  <title>PadelScore — Band 9 Active PWA</title>
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

const indexPath = path.join(outDir, 'index.html');
fs.writeFileSync(indexPath, html, 'utf8');

const htmlSize = Buffer.byteLength(html, 'utf8');
const jsSize = fs.statSync(path.join(outDir, 'app.js')).size;
const cssSize = fs.statSync(path.join(outDir, 'styles.css')).size;
console.log(
  `Built static PWA bundle: dist/index.html (${htmlSize} B), dist/app.js (${jsSize} B), dist/styles.css (${cssSize} B)`
);
