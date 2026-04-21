const btn           = document.getElementById('captureBtn');
const statusEl      = document.getElementById('status');
const progressWrap  = document.getElementById('progressWrap');
const progressBar   = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');

let selectedFormat  = 'pdf';
let selectedQuality = 0.85;
let selectedMethod  = 'scroll';

// ── Pill groups ────────────────────────────────────────────────────
document.getElementById('formatGroup').querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.getElementById('formatGroup').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    selectedFormat = pill.dataset.value;
  });
});

document.getElementById('qualityGroup').querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.getElementById('qualityGroup').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    selectedQuality = parseFloat(pill.dataset.value);
  });
});

document.getElementById('methodGroup').querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.getElementById('methodGroup').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    selectedMethod = pill.dataset.value;
    document.getElementById('methodHint').textContent = pill.dataset.hint;
  });
});

// ── Helpers ────────────────────────────────────────────────────────
function setProgress(pct, label) {
  progressBar.style.width = pct + '%';
  progressLabel.textContent = label;
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src     = url;
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function runInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results?.[0]?.result;
}

// ── Export helpers ─────────────────────────────────────────────────
async function canvasToOutput(canvas, title, format, quality) {
  const rawTitle = title.replace(/[^a-z0-9\s\-_]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'page';
  const dateStr  = new Date().toISOString().slice(0, 10);

  if (format === 'png') {
    return { dataUrl: canvas.toDataURL('image/png'), filename: `${rawTitle}_${dateStr}.png` };
  }
  if (format === 'jpeg') {
    return { dataUrl: canvas.toDataURL('image/jpeg', quality), filename: `${rawTitle}_${dateStr}.jpg` };
  }

  // PDF
  if (!window.jspdf) await loadScript(chrome.runtime.getURL('lib/jspdf.umd.min.js'));
  const { jsPDF } = window.jspdf;
  const A4_W = 210, A4_H = 297;
  const pdf  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const imgData    = canvas.toDataURL('image/jpeg', quality);
  const imgW       = A4_W;
  const imgH       = (canvas.height * A4_W) / canvas.width;
  const totalPages = Math.ceil(imgH / A4_H);
  for (let i = 0; i < totalPages; i++) {
    if (i > 0) pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 0, -(i * A4_H), imgW, imgH);
  }
  return { dataUrl: pdf.output('datauristring'), filename: `${rawTitle}_${dateStr}.pdf` };
}

// ── Method: DOM (html2canvas) ──────────────────────────────────────
async function captureDOM(tab, format, quality) {
  setProgress(15, 'Loading capture library...');
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/html2canvas.min.js'] });

  if (format === 'pdf') {
    setProgress(30, 'Loading PDF library...');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/jspdf.umd.min.js'] });
  }

  setProgress(45, 'Capturing page...');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func:   domCapturePage,
    args:   [{ quality, format }],
  });

  const result = results?.[0]?.result;
  if (!result?.success) throw new Error(result?.error || 'Capture failed');
  return result;
}

// Runs inside tab context for DOM method
function domCapturePage(options) {
  return new Promise((resolve) => {
    try {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      window.scrollTo(0, 0);

      const pageWidth  = Math.max(document.body.scrollWidth,  document.documentElement.scrollWidth);
      const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

      const captureTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Capture timed out after 30s')), 30000)
      );

      /* eslint-disable no-undef */
      Promise.race([
        html2canvas(document.documentElement, {
          allowTaint:             true,
          useCORS:                true,
          foreignObjectRendering: false,
          scale:                  1,
          scrollX:                0,
          scrollY:                0,
          x:                      0,
          y:                      0,
          width:                  pageWidth,
          height:                 pageHeight,
          windowWidth:            pageWidth,
          windowHeight:           pageHeight,
          backgroundColor:        '#ffffff',
          logging:                false,
          imageTimeout:           8000,
          onclone: (doc) => {
            doc.documentElement.style.overflow = 'visible';
            doc.querySelectorAll('video, iframe, canvas').forEach(el => el.remove());
          },
        }),
        captureTimeout,
      ]).then((canvas) => {
        window.scrollTo(scrollX, scrollY);
        const rawTitle  = (document.title || 'page').replace(/[^a-z0-9\s\-_]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'page';
        const dateStr   = new Date().toISOString().slice(0, 10);
        const fmt       = options.format;

        if (fmt === 'png') {
          resolve({ success: true, dataUrl: canvas.toDataURL('image/png'), filename: `${rawTitle}_${dateStr}.png` });
          return;
        }
        if (fmt === 'jpeg') {
          resolve({ success: true, dataUrl: canvas.toDataURL('image/jpeg', options.quality), filename: `${rawTitle}_${dateStr}.jpg` });
          return;
        }
        const { jsPDF } = window.jspdf;
        const A4_W = 210, A4_H = 297;
        const pdf  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
        const imgW       = A4_W;
        const imgH       = (canvas.height * A4_W) / canvas.width;
        const totalPages = Math.ceil(imgH / A4_H);
        const imgData    = canvas.toDataURL('image/jpeg', options.quality);
        for (let i = 0; i < totalPages; i++) {
          if (i > 0) pdf.addPage();
          pdf.addImage(imgData, 'JPEG', 0, -(i * A4_H), imgW, imgH);
        }
        resolve({ success: true, dataUrl: pdf.output('datauristring'), filename: `${rawTitle}_${dateStr}.pdf` });
      }).catch((err) => {
        window.scrollTo(scrollX, scrollY);
        resolve({ success: false, error: err.message });
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

// ── Method: Scroll & stitch ────────────────────────────────────────
async function captureScroll(tab, format, quality) {
  setProgress(10, 'Measuring page...');

  const dims = await runInTab(tab.id, () => ({
    scrollHeight:   Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    viewportHeight: window.innerHeight,
    viewportWidth:  window.innerWidth,
    dpr:            Math.min(window.devicePixelRatio || 1, 2),
    title:          document.title || 'page',
  }));

  const { scrollHeight, viewportHeight, viewportWidth, dpr, title } = dims;
  const totalSteps = Math.ceil(scrollHeight / viewportHeight);

  await runInTab(tab.id, () => window.scrollTo(0, 0));
  await sleep(500);

  const captures  = [];
  let   scrollPos = 0;

  for (let step = 0; step < totalSteps + 1; step++) {
    const pct = 10 + Math.round((step / totalSteps) * 70);
    setProgress(pct, `Capturing section ${step + 1} of ${totalSteps}...`);

    await runInTab(tab.id, (pos) => window.scrollTo(0, pos), [scrollPos]);
    await sleep(400);

    const actualPos = await runInTab(tab.id, () => window.scrollY);
    const dataUrl   = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    captures.push({ dataUrl, scrollPos: actualPos });

    const nextPos = scrollPos + viewportHeight;
    if (nextPos >= scrollHeight) break;
    scrollPos = nextPos;
  }

  await runInTab(tab.id, () => window.scrollTo(0, 0));

  setProgress(82, 'Stitching image...');

  const canvasW = Math.round(viewportWidth * dpr);
  const canvasH = Math.round(scrollHeight  * dpr);
  const canvas  = document.createElement('canvas');
  canvas.width  = canvasW;
  canvas.height = canvasH;
  const ctx     = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  for (let i = 0; i < captures.length; i++) {
    const { dataUrl: dUrl, scrollPos: pos } = captures[i];
    const img   = await loadImage(dUrl);
    const destY = Math.round(pos * dpr);

    if (i < captures.length - 1) {
      ctx.drawImage(img, 0, destY, canvasW, Math.round(viewportHeight * dpr));
    } else {
      const remaining = scrollHeight - pos;
      const srcH      = Math.round(remaining * dpr);
      ctx.drawImage(img, 0, 0, img.naturalWidth, srcH, 0, destY, canvasW, srcH);
    }
  }

  setProgress(90, 'Saving file...');
  return canvasToOutput(canvas, title, format, quality);
}

// ── Main click handler ─────────────────────────────────────────────
btn.addEventListener('click', async () => {
  btn.disabled = true;
  setStatus('');
  progressWrap.classList.add('visible');
  setProgress(5, 'Starting...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') || tab.url?.startsWith('edge://')) {
      throw new Error('Cannot capture browser internal pages');
    }

    let result;

    if (selectedMethod === 'dom') {
      result = await captureDOM(tab, selectedFormat, selectedQuality);
      await chrome.downloads.download({ url: result.dataUrl, filename: result.filename, saveAs: false });
    } else {
      result = await captureScroll(tab, selectedFormat, selectedQuality);
      await chrome.downloads.download({ url: result.dataUrl, filename: result.filename, saveAs: false });
    }

    setProgress(100, 'Done');
    setStatus(`Saved: ${result.filename}`, 'success');

  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setProgress(0, '');
    progressWrap.classList.remove('visible');
  } finally {
    btn.disabled = false;
  }
});
