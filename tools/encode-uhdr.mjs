#!/usr/bin/env node
// Encode a Radiance .hdr (equirect) into an Ultra HDR JPEG (SDR JPEG + gain map, XMP hdrgm + MPF container)
// tuned for three r186 UltraHDRLoader. Usage:
//   node tools/encode-uhdr.mjs [in.hdr out.jpg] [--sdrQ 88] [--gainQ 85] [--gainScale 2]
// With no paths it encodes assets-src/env/sunset_2k.hdr -> public/env/sunset_2k_uhdr.jpg (npm run assets:env).
// Output is deterministic: the same .hdr and options reproduce the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_IN = path.join(ROOT, 'assets-src/env/sunset_2k.hdr');
const DEFAULT_OUT = path.join(ROOT, 'public/env/sunset_2k_uhdr.jpg');

/** Decode Radiance RGBE (new-style RLE or flat) -> Float32Array RGB, top-down rows. Same scale as three HDRLoader. */
function readRGBE(buf) {
  let p = 0;
  const line = () => { let s = ''; while (buf[p] !== 0x0a) s += String.fromCharCode(buf[p++]); p++; return s; };
  let l; do { l = line(); } while (l !== '');
  const res = line(); const m = res.match(/-Y (\d+) \+X (\d+)/); if (!m) throw new Error('bad res ' + res);
  const h = +m[1], w = +m[2];
  const rgbe = new Uint8Array(w * h * 4);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === w) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          let n = buf[p++];
          if (n > 128) { n -= 128; const v = buf[p++]; for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v; }
          else { for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = buf[p++]; }
        }
      }
    } else { for (let i = 0; i < w * 4; i++) scan[i] = buf[p++]; }
    rgbe.set(scan, y * w * 4);
  }
  const data = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    const e = rgbe[i + 3]; if (e === 0) continue;
    const s = Math.pow(2, e - 128) / 255;
    data[j] = rgbe[i] * s; data[j + 1] = rgbe[i + 1] * s; data[j + 2] = rgbe[i + 2] * s;
  }
  return { w, h, data };
}

// Offline Ultra HDR (JPEG + gain map, XMP hdrgm metadata + MPF container) encoder that targets the exact
// reconstruction math of three r186 examples/jsm/loaders/UltraHDRLoader.js (gain map decoded with
// canvas bilinear upsampling, HDRCapacityMin = 0, offsets 1/64).

const W8 = Math.log2(1.8) * 0.5; // three's weightFactor when HDRCapacityMin = 0  (= 0.42399)
const OS = 1.0, OH = 1.0;        // offsets in 0..255 units -> XMP 1/64 (three multiplies XMP offsets by 64)
const srgbExt = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055); // extended sRGB OETF (valid >1)

/** Bilinear resize with half-pixel centres and edge clamp (what canvas drawImage does for upscaling). */
function bilinear(src, sw, sh, ch, dw, dh) {
  const out = new Float32Array(dw * dh * ch);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5)); const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5)); const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < ch; c++) {
        const a = src[(y0 * sw + x0) * ch + c], b = src[(y0 * sw + x1) * ch + c], d = src[(y1 * sw + x0) * ch + c], e = src[(y1 * sw + x1) * ch + c];
        out[(y * dw + x) * ch + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
      }
    }
  }
  return out;
}

/**
 * @param img {w,h,data Float32 RGB linear}
 * @param o {gainScale: 1|2|4, sdrQ, gainQ, knee, sdrSub:'4:2:0'|'4:4:4', mozjpeg}
 */
async function encodeUltraHDR(img, o = {}) {
  const { w, h, data } = img;
  const { gainScale = 2, sdrQ = 88, gainQ = 85, knee = 0.6, sdrSub = '4:2:0', mozjpeg = true } = o;
  // 1) SDR tone curve (luminance-preserving hue): identity below knee, exponential shoulder to 1.0 above.
  const T = (L) => (L <= knee ? L : knee + (1 - knee) * (1 - Math.exp(-(L - knee) / (1 - knee))));
  const N = w * h;
  const need = new Float32Array(N); // required logBoost (decoder units) using the max channel
  const E = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = Math.max(0, data[i * 3]), g = Math.max(0, data[i * 3 + 1]), b = Math.max(0, data[i * 3 + 2]);
    const m = Math.max(r, g, b);
    for (let c = 0; c < 3; c++) E[i * 3 + c] = 255 * srgbExt(Math.max(0, data[i * 3 + c]));
    if (m <= 0) { need[i] = 0; continue; }
    const sm = T(m); // SDR value of the max channel
    const ratio = (255 * srgbExt(m) + OH) / (255 * srgbExt(sm) + OS);
    need[i] = Math.log2(ratio) / W8;
  }
  // 2) low-res gain map: block max, then 3x3 dilation so bilinear upsampling never under-boosts.
  const gw = w / gainScale, gh = h / gainScale;
  let low = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let mx = 0; for (let j = 0; j < gainScale; j++) for (let i = 0; i < gainScale; i++) mx = Math.max(mx, need[(y * gainScale + j) * w + x * gainScale + i]);
    low[y * gw + x] = mx;
  }
  if (gainScale > 1) {
    const d = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let mx = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const yy = Math.min(gh - 1, Math.max(0, y + j)), xx = (x + i + gw) % gw; mx = Math.max(mx, low[yy * gw + xx]); }
      d[y * gw + x] = mx;
    }
    low = d;
  }
  let gmin = Infinity, gmax = -Infinity; for (const v of low) { gmin = Math.min(gmin, v); gmax = Math.max(gmax, v); }
  gmin = Math.min(gmin, 0); if (gmax - gmin < 1e-3) gmax = gmin + 1e-3;
  const gbytes = Buffer.alloc(gw * gh);
  for (let i = 0; i < gw * gh; i++) gbytes[i] = Math.min(255, Math.ceil(((low[i] - gmin) / (gmax - gmin)) * 255 - 1e-6)); // ceil: never under-boost
  const gainJpg = await sharp(gbytes, { raw: { width: gw, height: gh, channels: 1 } }).jpeg({ quality: gainQ, mozjpeg, chromaSubsampling: '4:4:4' }).toBuffer();
  // 3) decode the gain map exactly as the loader will see it, upsample, and compensate the SDR for its errors.
  const gdec = await sharp(gainJpg).raw().toBuffer({ resolveWithObject: true });
  const gch = gdec.info.channels; const gsrc = new Float32Array(gw * gh * gch); for (let i = 0; i < gsrc.length; i++) gsrc[i] = gdec.data[i];
  const gup = gainScale === 1 ? gsrc : bilinear(gsrc, gw, gh, gch, w, h);
  const sdr = Buffer.alloc(N * 3); let clipHi = 0, clipLo = 0;
  for (let i = 0; i < N; i++) {
    // canvas getImageData rounds the interpolated value to a byte
    const gb = Math.round(gup[i * gch]) / 255;
    const boost = Math.pow(2, (gmin + (gmax - gmin) * gb) * W8);
    for (let c = 0; c < 3; c++) {
      let s = (E[i * 3 + c] + OH) / boost - OS;
      if (s > 255) { clipHi++; s = 255; } if (s < 0) { if (s < -0.5) clipLo++; s = 0; }
      sdr[i * 3 + c] = Math.round(s);
    }
  }
  const sdrJpg = await sharp(sdr, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: sdrQ, mozjpeg, chromaSubsampling: sdrSub }).toBuffer();
  const file = assemble(sdrJpg, gainJpg, { gmin, gmax });
  return { file, sdrJpg, gainJpg, meta: { gmin, gmax, gw, gh, clipHi, clipLo } };
}

function app(marker, payload) {
  const len = payload.length + 2; if (len > 0xffff) throw new Error('segment too big');
  return Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 255]), payload]);
}
const XMP_NS = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
function xmpPrimary(gainLen) {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="heartbeat-villa uhdr"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainLen}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
function xmpGain({ gmin, gmax }) {
  // Values are log2 boosts in three's decoder units (~= spec log2 linear gain / 1.017).
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="heartbeat-villa uhdr"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="${gmin.toFixed(6)}" hdrgm:GainMapMax="${gmax.toFixed(6)}" hdrgm:Gamma="1.0" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0.0" hdrgm:HDRCapacityMax="${gmax.toFixed(6)}" hdrgm:BaseRenditionIsHDR="False"/></rdf:RDF></x:xmpmeta>`;
}
function mpf(primarySize, gainSize, gainOffsetFromTiff) {
  const b = Buffer.alloc(4 + 8 + 2 + 36 + 4 + 32);
  let p = 0; b.write('MPF\0', p, 'latin1'); p += 4;
  b.write('MM', p, 'latin1'); b.writeUInt16BE(0x2a, p + 2); b.writeUInt32BE(8, p + 4); p += 8; // big-endian TIFF header, IFD at +8
  b.writeUInt16BE(3, p); p += 2;
  b.writeUInt16BE(0xb000, p); b.writeUInt16BE(7, p + 2); b.writeUInt32BE(4, p + 4); b.write('0100', p + 8, 'latin1'); p += 12;
  b.writeUInt16BE(0xb001, p); b.writeUInt16BE(4, p + 2); b.writeUInt32BE(1, p + 4); b.writeUInt32BE(2, p + 8); p += 12;
  b.writeUInt16BE(0xb002, p); b.writeUInt16BE(7, p + 2); b.writeUInt32BE(32, p + 4); b.writeUInt32BE(8 + 2 + 36 + 4, p + 8); p += 12;
  b.writeUInt32BE(0, p); p += 4; // next IFD
  b.writeUInt32BE(0x030000, p); b.writeUInt32BE(primarySize, p + 4); b.writeUInt32BE(0, p + 8); b.writeUInt32BE(0, p + 12); p += 16; // primary
  b.writeUInt32BE(0, p); b.writeUInt32BE(gainSize, p + 4); b.writeUInt32BE(gainOffsetFromTiff, p + 8); b.writeUInt32BE(0, p + 12); p += 16;
  return b;
}
/** Strip SOI, return [SOI, rest]; drop any APP1/APP2 sharp may have written. */
function splitJpeg(j) {
  if (j[0] !== 0xff || j[1] !== 0xd8) throw new Error('not jpeg');
  let p = 2; const keep = [];
  while (j[p] === 0xff && j[p + 1] >= 0xe0 && j[p + 1] <= 0xef) { const len = j.readUInt16BE(p + 2); if (j[p + 1] === 0xe0) keep.push(j.subarray(p, p + 2 + len)); p += 2 + len; }
  return { appKeep: Buffer.concat(keep), rest: j.subarray(p) };
}
function assemble(sdrJpg, gainJpg, meta) {
  const g = splitJpeg(gainJpg);
  const gainFile = Buffer.concat([Buffer.from([0xff, 0xd8]), g.appKeep, app(0xe1, Buffer.concat([XMP_NS, Buffer.from(xmpGain(meta))])), g.rest]);
  const s = splitJpeg(sdrJpg);
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), s.appKeep, app(0xe1, Buffer.concat([XMP_NS, Buffer.from(xmpPrimary(gainFile.length))]))]);
  const mpfLen = 4 + mpf(0, 0, 0).length;
  const primarySize = head.length + mpfLen + s.rest.length;
  const tiffPos = head.length + 4 + 4; // marker(2)+len(2)+'MPF\0'(4)
  const primary = Buffer.concat([head, app(0xe2, mpf(primarySize, gainFile.length, primarySize - tiffPos)), s.rest]);
  if (primary.length !== primarySize) throw new Error('size mismatch');
  return Buffer.concat([primary, gainFile]);
}


const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [input, output] = pos.length ? pos : [DEFAULT_IN, DEFAULT_OUT];
if (!input || !output) { console.error('usage: encode-uhdr.mjs [in.hdr out.jpg] [--sdrQ 88] [--gainQ 85] [--gainScale 2]'); process.exit(1); }
const img = readRGBE(fs.readFileSync(input));
const r = await encodeUltraHDR(img, { sdrQ: opt('sdrQ', 88), gainQ: opt('gainQ', 85), gainScale: opt('gainScale', 2) });
fs.writeFileSync(output, r.file);
console.log(`${output}: ${img.w}x${img.h} -> ${r.file.length} bytes (sdr ${r.sdrJpg.length}, gain ${r.meta.gw}x${r.meta.gh} ${r.gainJpg.length}), gainMapMax ${r.meta.gmax.toFixed(3)}, clipped ${r.meta.clipHi}`);
