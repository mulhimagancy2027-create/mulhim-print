const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { print, getPrinters } = require('pdf-to-printer');
const { rng } = require('./shared');

const DB = () => path.join(app.getPath('userData'), 'mulhim.json');
const MM = v => v * 72 / 25.4;
const SZ = { A3: [MM(297), MM(420)], A4: [MM(210), MM(297)], A5: [MM(148), MM(210)], A6: [MM(105), MM(148)], 'A3+': [MM(329), MM(483)] };

function createWindow() {
  const w = new BrowserWindow({
    width: 1240, height: 820, autoHideMenuBar: true, title: 'ملهم طباعة',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  w.loadFile('index.html');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('store:get', () => { try { return JSON.parse(fs.readFileSync(DB(), 'utf8')); } catch { return null; } });
ipcMain.handle('store:set', (_, d) => { fs.writeFileSync(DB(), JSON.stringify(d)); return true; });

ipcMain.handle('printers:list', async () => (await getPrinters()).map(p => ({ name: p.name || p.deviceId })));

ipcMain.handle('printers:test', async (_, { name, label }) => {
  try {
    const d = await PDFDocument.create(), pg = d.addPage([MM(210), MM(297)]);
    const f = await d.embedFont(StandardFonts.HelveticaBold);
    pg.drawText(label, { x: 50, y: 520, size: 60, font: f, color: rgb(0, 0, 0) });
    pg.drawText(name.replace(/[^\x20-\x7e]/g, '?'), { x: 50, y: 470, size: 14, font: f });
    const file = path.join(os.tmpdir(), 'mulhim-test.pdf');
    fs.writeFileSync(file, await d.save());
    await print(file, { printer: name, silent: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('file:pick', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF / صور', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('file:info', async (_, p) => {
  const ext = path.extname(p).toLowerCase();
  let pages = 1;
  if (ext === '.pdf') pages = (await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true })).getPageCount();
  return { path: p, name: path.basename(p), type: ext === '.pdf' ? 'pdf' : 'img', pages };
});

async function loadSrc(f) {
  const b = fs.readFileSync(f), ext = path.extname(f).toLowerCase();
  if (ext === '.pdf') return PDFDocument.load(b, { ignoreEncryption: true });
  const d = await PDFDocument.create();
  const im = ext === '.png' ? await d.embedPng(b) : await d.embedJpg(b);
  d.addPage([im.width, im.height]).drawImage(im, { x: 0, y: 0, width: im.width, height: im.height });
  return d;
}

// Builds the final sheet-ready PDF: size, n-up, booklet imposition, Arabic (RTL) order
async function compose(j) {
  const src = await loadSrc(j.file.path);
  const idx = rng(j.range, src.getPageCount());
  const out = await PDFDocument.create();
  const emb = await out.embedPdf(src, idx);
  const land = j.layout === 'nup2' || j.layout === 'booklet';
  let [w, h] = SZ[j.size] || SZ.A4;
  if (land) [w, h] = [h, w];
  const cols = (j.layout === 'nup4' || land) ? 2 : 1, rows = j.layout === 'nup4' ? 2 : 1;
  const slots = cols * rows, sw = w / cols, sh = h / rows;
  let order = emb.map((_, i) => i);
  if (j.layout === 'booklet') {
    const n = Math.ceil(order.length / 4) * 4, o = [];
    for (let i = 0; i < n / 4; i++) o.push(n - 1 - 2 * i, 2 * i, 2 * i + 1, n - 2 - 2 * i);
    order = o.map(i => i < emb.length ? i : null);
  }
  const m = j.layout === 'normal' ? 0 : MM(4);
  for (let s = 0; s < order.length; s += slots) {
    const pg = out.addPage([w, h]);
    for (let k = 0; k < slots; k++) {
      const e = emb[order[s + k]];
      if (!e) continue;
      let col = k % cols; const row = Math.floor(k / cols);
      if (j.rtl && cols > 1) col = cols - 1 - col;
      const sc = Math.min((sw - 2 * m) / e.width, (sh - 2 * m) / e.height);
      pg.drawPage(e, { x: col * sw + (sw - e.width * sc) / 2, y: h - (row + 1) * sh + (sh - e.height * sc) / 2, width: e.width * sc, height: e.height * sc });
    }
  }
  const f = path.join(os.tmpdir(), 'mulhim-' + j.id + '.pdf');
  fs.writeFileSync(f, await out.save());
  return f;
}

ipcMain.handle('job:run', async (_, j) => {
  try {
    const f = await compose(j);
    const land = j.layout === 'nup2' || j.layout === 'booklet';
    const dup = j.duplex || j.layout === 'booklet';
    for (const [printer, n] of Object.entries(j.alloc)) {
      if (!n) continue;
      await print(f, {
        printer, copies: n, silent: true, scale: 'noscale', monochrome: !j.color,
        orientation: land ? 'landscape' : 'portrait',
        side: dup ? (land ? 'duplexshort' : 'duplexlong') : 'simplex',
        paperSize: j.driverSize || undefined
      });
    }
    fs.unlink(f, () => {});
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
