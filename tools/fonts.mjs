#!/usr/bin/env node
// Self-hosts subset web fonts so the game does not depend on fonts.googleapis.com / fonts.gstatic.com
// (often blocked in mainland China).
//  1. collects every character the UI can show: string/template literal text in src/**/*.ts(x),
//     text + attribute values of index.html, quoted strings in src/style.css, printable ASCII and
//     common CJK punctuation -> tools/fonts.chars.txt (sorted, unique)
//  2. asks Google Fonts for a subset of each face with exactly those characters (css2 &text=, woff2)
//  3. writes public/fonts/<Family>-<weight>.woff2 and public/fonts/fonts.css (relative urls with ?v=<content hash>,
//     so the service worker can cache them forever)
//
//   node tools/fonts.mjs          (npm run assets:fonts)   re-run whenever UI text changes.
//
// Characters typed by players (nicknames, chat) that are not in the subset render in the next font of
// the stack (PingFang SC / Microsoft YaHei / system sans-serif).
// Fonts: Noto Sans SC and ZCOOL KuaiLe, SIL Open Font License 1.1 (self-hosting and subsetting allowed).
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvHttpProxyAgent, setGlobalDispatcher, fetch } from 'undici';
// TS parser (oxc) that ships with Vite 8; without it every character of each source file is kept (superset).
const parseAst = await import('rolldown/parseAst').then((m) => m.parseAst, () => null);
if (!parseAst) console.warn('warn: rolldown/parseAst unavailable; collecting all characters of src files');

// Node's fetch ignores HTTPS_PROXY; route through it when one is set.
if (['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].some((k) => process.env[k])) setGlobalDispatcher(new EnvHttpProxyAgent());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/fonts');
const CHARS_FILE = path.join(ROOT, 'tools/fonts.chars.txt');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Faces actually used by src/style.css (--hz, --body). font-weight 900 in the CSS resolves to the 700 face.
const FACES = [
  { family: 'ZCOOL KuaiLe', weight: 400 },
  { family: 'Noto Sans SC', weight: 400 },
  { family: 'Noto Sans SC', weight: 700 },
];
const CJK_PUNCT = '，。！？：；、“”‘’（）《》…—·～';

// ---------- 1. collect characters ----------
async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** String literal values, template literal chunks and JSX text of a TS/TSX module. */
function tsStrings(code, file) {
  const lang = file.endsWith('.tsx') ? 'tsx' : 'ts';
  if (!parseAst) return [code];
  let ast;
  try { ast = parseAst(code, { lang }, file); } catch (e) {
    console.warn(`warn: could not parse ${path.relative(ROOT, file)} (${e.message.split('\n')[0]}); using the whole file`);
    return [code];
  }
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value);
    else if (n.type === 'TemplateElement') out.push(n.value.cooked ?? n.value.raw);
    else if (n.type === 'JSXText') out.push(n.value);
    for (const k in n) if (k !== 'parent' && n[k] && typeof n[k] === 'object') visit(n[k]);
  };
  visit(ast);
  return out;
}

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_, n) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]);

/** Text nodes and attribute values of an HTML document (scripts/styles/comments skipped). */
function htmlStrings(html) {
  const out = [];
  const TAG = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g; // quoted attribute values may contain < and >
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
  for (const tag of html.matchAll(TAG)) for (const a of tag[0].matchAll(/\s[\w:-]+\s*=\s*("([^"]*)"|'([^']*)')/g)) out.push(decodeEntities(a[2] ?? a[3]));
  for (const t of html.split(TAG)) out.push(decodeEntities(t));
  return out;
}

/** Quoted strings of a stylesheet (content: "…", quotes, …) with CSS escapes decoded. */
function cssStrings(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((m) => (m[1] ?? m[2])
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1'));
}

const texts = [];
for await (const f of walk(path.join(ROOT, 'src'))) {
  if (/\.tsx?$/.test(f)) texts.push(...tsStrings(await fs.readFile(f, 'utf8'), f));
}
texts.push(...htmlStrings(await fs.readFile(path.join(ROOT, 'index.html'), 'utf8')));
texts.push(...cssStrings(await fs.readFile(path.join(ROOT, 'src/style.css'), 'utf8')));
let ascii = ''; for (let c = 0x20; c <= 0x7e; c++) ascii += String.fromCharCode(c);
texts.push(ascii, CJK_PUNCT);

const set = new Set();
for (const t of texts) for (const ch of t) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // control characters, newlines, tabs
  set.add(cp);
}
const chars = String.fromCodePoint(...[...set].sort((a, b) => a - b));
await fs.writeFile(CHARS_FILE, chars);
const cjk = [...chars].filter((c) => /\p{Script=Han}/u.test(c)).length;
console.log(`${[...chars].length} characters (${cjk} Han) -> ${path.relative(ROOT, CHARS_FILE)}`);

// ---------- 2. fetch subsets ----------
const slug = (family) => family.replace(/\s+/g, '');
await fs.mkdir(OUT, { recursive: true });
const faces = [];
for (const { family, weight } of FACES) {
  const fam = `${family.replace(/ /g, '+')}:wght@${weight}`;
  const url = `https://fonts.googleapis.com/css2?family=${fam}&text=${encodeURIComponent(chars)}&display=swap`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${family} ${weight}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const css = await res.text();
  const blocks = [...css.matchAll(/@font-face\s*{([^}]*)}/g)];
  if (blocks.length !== 1) throw new Error(`${family} ${weight}: expected one @font-face, got ${blocks.length}`);
  const src = /url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/.exec(blocks[0][1]);
  if (!src) throw new Error(`${family} ${weight}: no woff2 src in response (User-Agent not treated as modern?)`);
  const fontRes = await fetch(src[1], { headers: { 'user-agent': UA } });
  if (!fontRes.ok) throw new Error(`${family} ${weight}: font HTTP ${fontRes.status}`);
  const buf = Buffer.from(await fontRes.arrayBuffer());
  if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${family} ${weight}: not a woff2 file`);
  const file = `${slug(family)}-${weight}.woff2`;
  await fs.writeFile(path.join(OUT, file), buf);
  faces.push({ family, weight, file, bytes: buf.length, v: createHash('sha256').update(buf).digest('hex').slice(0, 10) });
  console.log(`${file.padEnd(22)} ${String(buf.length).padStart(7)} B`);
}

// ---------- 3. stylesheet ----------
const css = [
  '/* Generated by tools/fonts.mjs: subsets of Google Fonts (SIL OFL 1.1) covering tools/fonts.chars.txt. */',
  ...faces.map(({ family, weight, file, v }) => `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url('./${file}?v=${v}') format('woff2');\n}`),
  '',
].join('\n');
await fs.writeFile(path.join(OUT, 'fonts.css'), css);
console.log(`fonts.css  total ${faces.reduce((s, f) => s + f.bytes, 0)} B woff2`);
