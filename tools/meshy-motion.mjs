#!/usr/bin/env node
// Meshy Text-to-Motion -> Animation API: one motion clip per prompt, retargeted onto each character's rig.
// Downloads assets-src/motions/<character>.<motion>.glb; tools/optimize.mjs merges those clips into the
// character GLBs. Resumable like tools/meshy.mjs: task ids are saved before polling, never re-created blindly.
//
//   MESHY_API_KEY=msy_... node tools/meshy-motion.mjs [--only hug_over,kiss] [--chars luxiao,sutang]
//
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvHttpProxyAgent, setGlobalDispatcher, fetch } from 'undici';

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());

const KEY = process.env.MESHY_API_KEY;
if (!KEY) { console.error('MESHY_API_KEY missing'); process.exit(1); }

const API = 'https://api.meshy.ai/openapi';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'tools/motions.manifest.json');
const RIGS = path.join(ROOT, 'tools/meshy-tasks.json');
const STATE = path.join(ROOT, 'tools/meshy-motion-tasks.json');
const OUT = path.join(ROOT, 'assets-src/motions');

const args = process.argv.slice(2);
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? args[onlyArg + 1].split(',') : null;
const charsArg = args.indexOf('--chars');

const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const rigs = JSON.parse(await fs.readFile(RIGS, 'utf8'));
const chars = charsArg >= 0 ? args[charsArg + 1].split(',') : manifest.characters;
let state = {};
try { state = JSON.parse(await fs.readFile(STATE, 'utf8')); } catch {}

let saving = Promise.resolve();
const save = () => (saving = saving.then(() => fs.writeFile(STATE, JSON.stringify(state, null, 2))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (id, ...m) => console.log(new Date().toISOString().slice(11, 19), `[${id}]`, ...m);

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + url, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || (method === 'GET' && res.status >= 500)) && attempt < 30) { await sleep(15000); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
    return JSON.parse(text);
  }
}

async function poll(id, url) {
  let last = -1;
  for (;;) {
    const t = await api('GET', url);
    if (t.progress !== last) { log(id, url.split('/')[2], t.status, `${t.progress}%`); last = t.progress; }
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${url} ${t.status}: ${t.task_error?.message ?? ''}`);
    await sleep(6000);
  }
}

/** Create once (id persisted before polling), then poll. */
async function task(key, label, create, pollUrl) {
  if (!state[key]) {
    if (state[`${key}_pending`]) throw new Error(`${key}: creation outcome unknown; check the Meshy dashboard, then clear ${key}_pending`);
    state[`${key}_pending`] = true; await save();
    const { result } = await create();
    state[key] = result; delete state[`${key}_pending`]; await save();
    log(label, 'created', result);
  }
  return poll(label, pollUrl(state[key]));
}

async function download(url, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
}

const failures = [];
await Promise.all(manifest.motions.filter((m) => !only || only.includes(m.id)).map(async (m) => {
  try {
    await task(`motion:${m.id}`, m.id, () => api('POST', '/v1/text-to-motion', { prompt: m.prompt, mode: 'prime', duration: m.duration }),
      (id) => `/v1/text-to-motion/${id}`);
    await Promise.all(chars.map(async (c) => {
      const label = `${c}.${m.id}`;
      try {
        const rig = rigs[c]?.rig;
        if (!rig) throw new Error('no rig task id');
        const t = await task(`anim:${label}`, label, () => api('POST', '/v1/animations', { rig_task_id: rig, motion_task_id: state[`motion:${m.id}`] }),
          (id) => `/v1/animations/${id}`);
        await download(t.result.animation_glb_url, path.join(OUT, `${label}.glb`));
        log(label, 'DONE');
      } catch (e) { failures.push(label); log(label, 'ERROR', e.message); }
    }));
  } catch (e) { failures.push(m.id); log(m.id, 'ERROR', e.message); }
}));
await save();
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL OK');
