import sharp from 'sharp';
import fs from 'node:fs';
const [dir, out, ...names] = process.argv.slice(2);
const S = 300, cols = 4;
const files = names.filter(n => fs.existsSync(`${dir}/${n}.png`));
const rows = Math.ceil(files.length / cols);
const comps = await Promise.all(files.map(async (n, i) => ({
  input: await sharp(`${dir}/${n}.png`).resize(S, S, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).toBuffer(),
  left: (i % cols) * S, top: Math.floor(i / cols) * S,
})));
const labels = files.map((n, i) => `<text x="${(i % cols) * S + 8}" y="${Math.floor(i / cols) * S + 24}" font-size="20" font-family="Arial" fill="#d00">${n}</text>`).join('');
comps.push({ input: Buffer.from(`<svg width="${cols*S}" height="${rows*S}">${labels}</svg>`), left: 0, top: 0 });
await sharp({ create: { width: cols * S, height: rows * S, channels: 3, background: '#fff' } }).composite(comps).png().toFile(out);
console.log(out, files.length);
