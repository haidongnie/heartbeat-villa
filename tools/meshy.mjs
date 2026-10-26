#!/usr/bin/env node
// Meshy asset pipeline: text-to-3d preview -> refine (PBR) -> [rig -> animations] -> download.
// Resumable: every created task id is written to tools/meshy-tasks.json before polling,
// so re-running never pays twice for the same stage.
//
//   MESHY_API_KEY=msy_... node tools/meshy.mjs [--only a,b] [--until preview|refine|rig|anim]
//
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvHttpProxyAgent, setGlobalDispatcher, fetch } from 'undici';

// Node's fetch ignores HTTPS_PROXY; route through it when one is set.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent());

const KEY = process.env.MESHY_API_KEY;
if (!KEY) { console.error('MESHY_API_KEY missing'); process.exit(1); }

const API = 'https://api.meshy.ai/openapi';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'tools/assets.manifest.json');
const STATE = path.join(ROOT, 'tools/meshy-tasks.json');
const OUT = path.join(ROOT, 'assets-src');
const STAGES = ['preview', 'refine', 'rig', 'anim'];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('only')?.split(',');
const until = opt('until') ?? 'anim';
const full = opt('full')?.split(',') ?? []; // ids that ignore --until
const concurrency = Number(opt('concurrency') ?? 8);

const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
let state = {};
try { state = JSON.parse(await fs.readFile(STATE, 'utf8')); } catch {}

let saving = Promise.resolve();
function save() {
  saving = saving.then(() => fs.writeFile(STATE, JSON.stringify(state, null, 2)));
  return saving;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (id, ...m) => console.log(new Date().toISOString().slice(11, 19), `[${id}]`, ...m);

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + url, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 429 / 5xx on GET are safe to retry; on POST only 429 is (the task was not created).
    if ((res.status === 429 || (method === 'GET' && res.status >= 500)) && attempt < 30) {
      await sleep(15000);
      continue;
    }
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
    if (t.status === 'FAILED' || t.status === 'CANCELED') {
      throw new Error(`${url} ${t.status}: ${t.task_error?.message ?? ''}`);
    }
    await sleep(8000);
  }
}

async function download(url, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
}

async function stage(a, name, create, pollUrl) {
  const s = (state[a.id] ??= {});
  if (!s[name]) {
    if (s[`${name}_pending`]) {
      // A previous create call may have reached Meshy without us seeing the id: never re-create blindly.
      throw new Error(`${name} creation outcome unknown; check the Meshy dashboard, then clear ${name}_pending`);
    }
    s[`${name}_pending`] = true; await save();
    const { result } = await create();
    s[name] = result; delete s[`${name}_pending`]; await save();
    log(a.id, `created ${name}`, result);
  }
  return poll(a.id, pollUrl(s[name]));
}

async function run(a) {
  const stop = (n) => !full.includes(a.id) && STAGES.indexOf(n) > STAGES.indexOf(until);
  const kind = a.kind === 'character' ? 'characters' : 'props';

  const preview = await stage(a, 'preview', () => api('POST', '/v2/text-to-3d', {
    mode: 'preview',
    prompt: a.prompt,
    model_type: 'smart-topology',
    ai_model: 'meshy-t2.5',
    target_polycount: a.polycount ?? 15000,
    ...(a.kind === 'character' ? { pose_mode: 'a-pose' } : {}),
    target_formats: ['glb'],
  }), (id) => `/v2/text-to-3d/${id}`);
  if (preview.thumbnail_url) await download(preview.thumbnail_url, path.join(OUT, 'previews', `${a.id}.png`));
  if (stop('refine')) return;

  const refine = await stage(a, 'refine', () => api('POST', '/v2/text-to-3d', {
    mode: 'refine',
    preview_task_id: state[a.id].preview,
    enable_pbr: true,
    texture_prompt: a.texture,
    texture_resolution: '2k',
    target_formats: ['glb'],
  }), (id) => `/v2/text-to-3d/${id}`);
  if (refine.thumbnail_url) await download(refine.thumbnail_url, path.join(OUT, 'previews', `${a.id}.refined.png`));
  if (a.kind !== 'character') {
    await download(refine.model_urls.glb, path.join(OUT, kind, `${a.id}.glb`));
    log(a.id, 'DONE prop');
    return;
  }
  if (stop('rig')) return;

  const rig = await stage(a, 'rig', () => api('POST', '/v1/rigging', {
    input_task_id: state[a.id].refine,
    height_meters: a.height ?? 1.7,
  }), (id) => `/v1/rigging/${id}`);
  await download(rig.result.rigged_character_glb_url, path.join(OUT, kind, `${a.id}.rigged.glb`));
  if (stop('anim')) return;

  const anim = await stage(a, 'anim', () => api('POST', '/v1/animations', {
    rig_task_id: state[a.id].rig,
    action_ids: a.actions.map((x) => x.id),
  }), (id) => `/v1/animations/${id}`);
  await download(anim.result.animation_glb_url, path.join(OUT, kind, `${a.id}.glb`));
  state[a.id].clips = a.actions.map((x) => x.name); await save();
  log(a.id, 'DONE character');
}

const queue = manifest.assets.filter((a) => !only || only.includes(a.id));
const failures = [];
async function worker() {
  for (let a; (a = queue.shift());) {
    try { await run(a); } catch (e) { failures.push(a.id); log(a.id, 'ERROR', e.message); }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await save();
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL OK');
