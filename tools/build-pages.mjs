import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const entries = ['index.html', 'ambiente.html', 'assets', 'panels'];
const allowed = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf']);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Link simbolico nao permitido: ${filename}`);
    if (entry.isDirectory()) result.push(...await files(filename));
    else result.push(filename);
  }
  return result;
}
// Validate the source before replacing the generated directory.
for (const entry of entries) {
  const source = path.join(root, entry);
  const candidates = (await stat(source)).isDirectory() ? await files(source) : [source];
  for (const filename of candidates) {
    if (!allowed.has(path.extname(filename).toLowerCase())) throw new Error(`Arquivo inesperado: ${filename}`);
    if (filename.endsWith('.js')) execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' });
    if (!filename.endsWith('.html')) continue;
    const content = await readFile(filename, 'utf8');
    for (const match of content.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
      const url = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue;
      const local = decodeURIComponent(url.split(/[?#]/)[0]);
      if (!local) continue;
      const target = path.resolve(local.startsWith('/') ? root : path.dirname(filename), local.replace(/^\//, ''));
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Caminho externo: ${url}`);
      await stat(target).catch(() => { throw new Error(`Referencia ausente em ${filename}: ${url}`); });
    }
  }
}
if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Destino de build invalido');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of entries) await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
await writeFile(path.join(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: SAMEORIGIN
  Cache-Control: public, max-age=0, must-revalidate
`);
console.log(`Cloudflare Pages: ${(await files(output)).length} arquivos publicos validados em dist.`);
