// Assembles the static site that GitHub Pages serves: `node tools/build-site.js [outDir]`.
// StringScope has no bundler. This copies only the files the app loads into
// one folder (default `_site/`), so repo-only files (tests, tools, server.js,
// README) are not published. Every path in the app is relative, so the output
// works from any base path, such as https://popcornhax.github.io/stringscope/.
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] || join(root, '_site'));
const SITE = ['index.html', 'manifest.webmanifest', 'sw.js', '.nojekyll', 'css', 'js', 'icons', 'vendor', 'samples'];

if (out === resolve(root)) throw new Error('Refusing to build into the repository root');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const entry of SITE) {
  await stat(join(root, entry)); // fail loudly if a site file goes missing
  await cp(join(root, entry), join(out, entry), { recursive: true });
}
console.log(`Site built in ${out}`);
