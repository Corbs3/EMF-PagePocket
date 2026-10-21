// Builds the final file from screenshots. Runs in a hidden extension page, never on websites.
const MAX_SEGMENT = 16000; // tallest single canvas, safely under Chrome's 32,767px limit
let S = null;

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(
    (r) => send({ ok: true, ...r }),
    (e) => send({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

async function handle(m) {
  if (m.cmd === 'init') {
    S = { cssWidth: m.cssWidth, innerWidth: m.innerWidth, cssHeight: m.cssHeight, maxPixels: m.maxPixels || 150e6, ratio: null, segs: [] };
    return {};
  }
  if (!S) throw new Error('Capture was not started properly. Please try again.');
  if (m.cmd === 'slice')  return addSlice(m.dataUrl, m.y);
  if (m.cmd === 'finish') { const r = await finish(m); S = null; return r; }
  throw new Error('Unknown command');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read a screenshot'));
    img.src = src;
  });
}

function setup(ratio) {
  S.ratio = ratio;
  // Scale down only if the real stitched image would be too big for Chrome to handle
  S.scale = Math.min(1, Math.sqrt(S.maxPixels / ((S.cssWidth * ratio) * (S.cssHeight * ratio))));
  const k = ratio * S.scale;
  S.W = Math.max(1, Math.round(S.cssWidth * k));
  S.H = Math.max(1, Math.round(S.cssHeight * k));
  for (let y = 0; y < S.H; y += MAX_SEGMENT) {
    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = Math.min(MAX_SEGMENT, S.H - y);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    S.segs.push({ c, ctx, y });
  }
}

async function addSlice(dataUrl, y) {
  const img = await loadImage(dataUrl);
  if (!S.ratio) setup(img.naturalWidth / S.innerWidth);
  const k = S.ratio * S.scale;
  const srcW = Math.min(img.naturalWidth, Math.round(S.cssWidth * S.ratio)); // trims any scrollbar
  const dy = Math.round(y * k);
  const dh = Math.round(img.naturalHeight * S.scale);
  for (const s of S.segs) {
    if (dy + dh <= s.y || dy >= s.y + s.c.height) continue;
    s.ctx.drawImage(img, 0, 0, srcW, img.naturalHeight, 0, dy - s.y, S.W, dh);
  }
  return { capturedCss: img.naturalHeight / S.ratio };
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not build the image'))), type, quality);
  });
}

// A "quiet" row is one colour all the way across, a good place for a PDF page break
function isQuietRow(y) {
  const seg = S.segs.find((s) => y >= s.y && y < s.y + s.c.height);
  if (!seg) return false;
  const d = seg.ctx.getImageData(0, y - seg.y, S.W, 1).data;
  const r = d[0], g = d[1], b = d[2];
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) > 30) return false;
  }
  return true;
}

function findBreak(end, range) {
  for (let y = end; y > end - range; y--) if (isQuietRow(y)) return y;
  return end;
}

function buildPdf(quality) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pageH = Math.round(S.W * 297 / 210);
  const page = document.createElement('canvas');
  page.width = S.W;
  const pctx = page.getContext('2d');
  let start = 0, n = 0;
  while (start < S.H - 1) {
    let end = Math.min(start + pageH, S.H);
    if (end < S.H) end = findBreak(end, Math.round(pageH * 0.15));
    const h = end - start;
    page.height = h;
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, S.W, h);
    for (const s of S.segs) {
      if (end <= s.y || start >= s.y + s.c.height) continue;
      pctx.drawImage(s.c, 0, s.y - start);
    }
    if (n++) pdf.addPage();
    pdf.addImage(page.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, 210, (h * 210) / S.W, undefined, 'FAST');
    start = end;
  }
  return pdf.output('blob');
}

async function finish({ format, quality, dest, baseName }) {
  if (!S.segs.length) throw new Error('Nothing was captured. Please try again.');

  if (dest === 'clipboard') {
    if (S.segs.length > 1) throw new Error('This page is too long to copy. Save it as a PNG instead.');
    const blob = await toBlob(S.segs[0].c, 'image/png');
    return { clipUrl: URL.createObjectURL(blob) };
  }

  if (format === 'pdf') {
    const blob = buildPdf(quality);
    return { files: [{ url: URL.createObjectURL(blob), filename: `${baseName}.pdf` }] };
  }

  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext  = format === 'png' ? 'png' : 'jpg';
  const files = [];
  for (let i = 0; i < S.segs.length; i++) {
    const blob = await toBlob(S.segs[i].c, type, format === 'png' ? undefined : quality);
    const part = S.segs.length > 1 ? `_part${i + 1}` : '';
    files.push({ url: URL.createObjectURL(blob), filename: `${baseName}${part}.${ext}` });
  }
  return { files };
}
