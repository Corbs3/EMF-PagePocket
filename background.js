importScripts('shared.js');

// ── Tuning ─────────────────────────────────────────────────────────
const SETTLE_MS       = 350;    // wait after each scroll
const CAPTURE_GAP_MS  = 550;    // Chrome allows about 2 screenshots a second
const MAX_SECTIONS    = 80;     // stop runaway "infinite scroll" pages
const MAX_PIXELS      = 150e6;  // total stitched pixels before scaling down
const PAUSE_LIMIT_MS  = 120000; // give up if the user stays on another tab

let job = null;             // current or most recent job
let lastCaptureAt = 0;
let creatingOffscreen = null;
let clipboardPending = false;
const pendingDownloads = new Set();

class Cancelled extends Error {}

// ── Setup ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'pocket-page', title: 'Pocket this page', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'pocket-page' && tab?.id) startFromShortcut(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'pocket-page' && tab?.id) startFromShortcut(tab);
});

async function startFromShortcut(tab) {
  if (job?.status === 'running') return flashBadge('…', '#93A19A');
  const { settings } = await chrome.storage.local.get({ settings: PP_DEFAULTS });
  startJob(tab.id, { ...PP_DEFAULTS, ...settings }, 'download');
}

// ── Messages ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.target === 'offscreen') return;

  if (msg.type === 'start') {
    if (job?.status === 'running') {
      send({ ok: false, error: 'Already pocketing a page. Give me a moment!' });
      return;
    }
    startJob(msg.tabId, { ...PP_DEFAULTS, ...msg.settings }, msg.target || 'download');
    send({ ok: true });
    return;
  }
  if (msg.type === 'get-job') { send({ job: publicJob() }); return; }
  if (msg.type === 'cancel')  { if (job?.status === 'running') job.cancelled = true; send({ ok: true }); return; }
  if (msg.type === 'clipboard-done') { clipboardPending = false; maybeCloseOffscreen(); return; }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id)) return;
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    pendingDownloads.delete(delta.id);
    maybeCloseOffscreen();
  }
});

// ── Job state ──────────────────────────────────────────────────────
function publicJob() {
  if (!job) return null;
  const { status, phase, pct, label, error, result, target, finishedAt, paused } = job;
  return { status, phase, pct, label, error, result, target, finishedAt, paused };
}

function update(patch) {
  Object.assign(job, patch);
  chrome.runtime.sendMessage({ type: 'job', job: publicJob() }).catch(() => {});
}

function checkCancel() {
  if (job.cancelled) throw new Cancelled();
}

// ── Badge ──────────────────────────────────────────────────────────
function flashBadge(text, color, ms = 4000) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  if (ms) setTimeout(() => {
    if (job?.status !== 'running') chrome.action.setBadgeText({ text: '' });
  }, ms);
}

// ── Friendly errors ────────────────────────────────────────────────
function blockedReason(url = '') {
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):/i.test(url)) {
    return "Chrome keeps its own pages private, so I can't pocket this one.";
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    return 'The Chrome Web Store is off limits to extensions, sorry!';
  }
  return null;
}

function friendlyError(err, url = '') {
  const m = err?.message || String(err);
  if (url.startsWith('file:') && /cannot access|permission|not allowed/i.test(m)) {
    return "To pocket files on your computer, turn on 'Allow access to file URLs' for PagePocket in chrome://extensions.";
  }
  if (/activeTab|not been invoked|must request permission/i.test(m)) {
    return 'I need a fresh click on the PagePocket icon for this tab. Open me and try again.';
  }
  if (/chrome:\/\/|chrome-extension:\/\/|edge:\/\//i.test(m)) {
    return "Chrome keeps its own pages private, so I can't pocket this one.";
  }
  if (/cannot access|cannot be scripted|extensions gallery|permission/i.test(m)) {
    return "This page is shy. Chrome won't let me in here.";
  }
  return m;
}

// ── Offscreen document (stitching and file building) ───────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Stitches page screenshots together and builds the PDF or image file locally.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function off(cmd, data = {}) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ ...data, target: 'offscreen', cmd });
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong building the file.');
  return res;
}

async function maybeCloseOffscreen() {
  if (job?.status === 'running' || pendingDownloads.size || clipboardPending) return;
  try { await chrome.offscreen.closeDocument(); } catch (_) { /* already closed */ }
}

// ── Helpers ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inTab(func, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId: job.tabId }, func, args });
  return res?.[0]?.result;
}

function baseName(title) {
  const clean = (title || 'page').replace(/[^a-z0-9\s\-_]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'page';
  return `${clean}_${new Date().toISOString().slice(0, 10)}`;
}

// Screenshot the tab, waiting if the user has switched away, retrying if Chrome says "too fast"
async function grab() {
  let waited = 0;
  for (;;) {
    checkCancel();
    const [active] = await chrome.tabs.query({ active: true, windowId: job.windowId });
    if (active?.id === job.tabId) break;
    if (!job.paused) update({ paused: true, label: 'Paused: pop back to the tab you were pocketing' });
    await sleep(500);
    waited += 500;
    if (waited > PAUSE_LIMIT_MS) throw new Error('I waited a while for you to come back, so I stopped. Give it another go.');
  }
  if (job.paused) {
    update({ paused: false });
    await sleep(400);
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const gap = Date.now() - lastCaptureAt;
    if (gap < CAPTURE_GAP_MS) await sleep(CAPTURE_GAP_MS - gap);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(job.windowId, { format: 'png' });
    } catch (e) {
      if (/MAX_CAPTURE|quota|too many/i.test(e.message)) { await sleep(800); continue; }
      throw e;
    }
  }
  throw new Error('Chrome is a bit busy right now. Try again in a moment.');
}

// ── In-page functions (run inside the tab) ─────────────────────────
async function pagePrep(preload) {
  const sleepIn = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.documentElement;
  window.__pagepocket = { x: scrollX, y: scrollY, hidden: [], seen: new Set() };
  if (!document.getElementById('__pagepocket_style')) {
    const style = document.createElement('style');
    style.id = '__pagepocket_style';
    style.textContent = 'html, body { scroll-behavior: auto !important; }';
    (document.head || root).appendChild(style);
  }
  const height = () => Math.max(document.body?.scrollHeight || 0, root.scrollHeight);
  if (preload) {
    let steps = 0;
    for (let y = 0; y < height() && steps < 40; y += innerHeight, steps++) {
      scrollTo(0, y);
      await sleepIn(120);
    }
  }
  scrollTo(0, 0);
  await sleepIn(300);
  return {
    scrollHeight: height(),
    innerHeight,
    innerWidth,
    clientWidth: root.clientWidth || innerWidth,
    dpr: devicePixelRatio || 1,
    title: document.title,
  };
}

function pageScroll(y) {
  scrollTo(0, y);
}

// Hide fixed and sticky bars (headers, cookie banners) so they don't repeat in every section
function pageSettle(hide) {
  const st = window.__pagepocket;
  if (hide && st) {
    for (const el of document.querySelectorAll('body *')) {
      if (st.seen.has(el)) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < innerHeight * 0.5) {
        st.seen.add(el);
        st.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }
  return scrollY;
}

function pageRestore() {
  document.getElementById('__pagepocket_style')?.remove();
  const st = window.__pagepocket;
  if (!st) return;
  for (const [el, value, priority] of st.hidden) {
    if (value) el.style.setProperty('visibility', value, priority);
    else el.style.removeProperty('visibility');
  }
  scrollTo(st.x, st.y);
  delete window.__pagepocket;
}

function pageVisibleInfo() {
  const root = document.documentElement;
  return { innerHeight, innerWidth, clientWidth: root.clientWidth || innerWidth, title: document.title };
}

function pageDomRender(maxPixels) {
  return new Promise((resolve) => {
    const sx = scrollX, sy = scrollY;
    try {
      scrollTo(0, 0);
      const root = document.documentElement;
      const w = Math.max(document.body?.scrollWidth || 0, root.scrollWidth);
      const h = Math.max(document.body?.scrollHeight || 0, root.scrollHeight);
      const scale = Math.max(0.1, Math.min(devicePixelRatio || 1, 2, Math.sqrt(maxPixels / (w * h)), 32000 / h));
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Quick render took too long. Try Scroll & stitch instead.')), 45000));
      /* global html2canvas */
      Promise.race([
        html2canvas(root, {
          allowTaint: true, useCORS: true, foreignObjectRendering: false,
          scale, scrollX: 0, scrollY: 0, x: 0, y: 0,
          width: w, height: h, windowWidth: w, windowHeight: h,
          backgroundColor: '#ffffff', logging: false, imageTimeout: 8000,
          onclone: (doc) => {
            doc.documentElement.style.overflow = 'visible';
            doc.querySelectorAll('video, iframe, canvas').forEach((el) => el.remove());
          },
        }),
        timeout,
      ]).then((canvas) => {
        scrollTo(sx, sy);
        resolve({ ok: true, dataUrl: canvas.toDataURL('image/png'), width: w, height: h, title: document.title });
      }).catch((e) => {
        scrollTo(sx, sy);
        resolve({ ok: false, error: e.message });
      });
    } catch (e) {
      scrollTo(sx, sy);
      resolve({ ok: false, error: e.message });
    }
  });
}

// ── Capture methods ────────────────────────────────────────────────
async function captureVisible() {
  update({ phase: 'section', pct: 30, label: 'Snapping the visible area...' });
  const info = await inTab(pageVisibleInfo);
  await off('init', { cssWidth: info.clientWidth, innerWidth: info.innerWidth, cssHeight: info.innerHeight });
  const shot = await grab();
  await off('slice', { dataUrl: shot, y: 0 });
  return { title: info.title, truncated: false };
}

async function captureDom() {
  update({ phase: 'section', pct: 15, label: 'Painting a copy of the page...' });
  await chrome.scripting.executeScript({ target: { tabId: job.tabId }, files: ['lib/html2canvas.min.js'] });
  checkCancel();
  update({ pct: 35 });
  const r = await inTab(pageDomRender, [MAX_PIXELS / 1.5]);
  if (!r?.ok) throw new Error(r?.error || 'Quick render failed. Try Scroll & stitch instead.');
  checkCancel();
  await off('init', { cssWidth: r.width, innerWidth: r.width, cssHeight: r.height });
  await off('slice', { dataUrl: r.dataUrl, y: 0 });
  return { title: r.title, truncated: false };
}

async function captureScroll() {
  update({ phase: 'preload', pct: 5, label: 'Waking up lazy images...' });
  const dims = await inTab(pagePrep, [true]);
  checkCancel();

  const vh = Math.max(1, dims.innerHeight);
  const cssHeight = dims.scrollHeight;
  let truncated = false;

  await off('init', { cssWidth: dims.clientWidth, innerWidth: dims.innerWidth, cssHeight, maxPixels: MAX_PIXELS });

  // Step by what each screenshot really covers, so there are never gaps
  let step = vh, y = 0, i = 0, lastPos = -1;
  while (y < cssHeight && i < MAX_SECTIONS) {
    checkCancel();
    const total = Math.max(i + 1, i + Math.ceil((cssHeight - y) / step));
    update({ phase: 'section', pct: 15 + Math.round((i / total) * 70), label: `Folding section ${i + 1} of ${total}...` });
    await inTab(pageScroll, [y]);
    await sleep(SETTLE_MS);
    const pos = await inTab(pageSettle, [i > 0]);
    if (i > 0) await sleep(80);
    if (pos <= lastPos) break; // page stopped scrolling
    const shot = await grab();
    const r = await off('slice', { dataUrl: shot, y: pos });
    if (r.capturedCss) step = Math.max(50, Math.min(vh, Math.floor(r.capturedCss)));
    lastPos = pos;
    i++;
    y = pos + step;
  }
  if (y < cssHeight && i >= MAX_SECTIONS) truncated = true;
  return { title: dims.title, truncated };
}

// ── Run a job ──────────────────────────────────────────────────────
async function startJob(tabId, settings, target) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    tab = { id: tabId };
  }
  job = {
    tabId, windowId: tab.windowId, url: tab.url || '', settings, target,
    status: 'running', phase: 'start', pct: 2, label: 'Getting ready...',
    cancelled: false, paused: false, error: null, result: null, finishedAt: null,
  };
  update({});
  chrome.action.setBadgeBackgroundColor({ color: '#2E9E6B' });
  chrome.action.setBadgeText({ text: '…' });

  const usesScroll = settings.mode === 'full' && settings.method === 'scroll';
  try {
    const blocked = blockedReason(job.url);
    if (blocked) throw new Error(blocked);

    let cap;
    if (settings.mode === 'visible') cap = await captureVisible();
    else if (settings.method === 'dom') cap = await captureDom();
    else cap = await captureScroll();

    if (usesScroll) await inTab(pageRestore).catch(() => {});
    checkCancel();

    const toClipboard = target === 'clipboard';
    update({ phase: 'stitch', pct: 88, label: toClipboard ? 'Getting it ready to paste...' : 'Stitching it all together...' });
    const built = await off('finish', {
      format: toClipboard ? 'png' : settings.format,
      quality: settings.quality,
      dest: target,
      baseName: baseName(tab.title || cap.title),
    });

    const store = await chrome.storage.local.get({ count: 0, recent: [] });
    const count = store.count + 1;
    const before = ppMilestoneFor(store.count);
    const now = ppMilestoneFor(count);
    const newMilestone = now && now !== before ? now.name : null;

    let result;
    if (toClipboard) {
      clipboardPending = true;
      setTimeout(() => { clipboardPending = false; maybeCloseOffscreen(); }, 30000);
      result = { clipUrl: built.clipUrl, count, milestone: now?.name || null, newMilestone, truncated: cap.truncated };
    } else {
      update({ phase: 'save', pct: 95, label: 'Tucking it into your Downloads...' });
      const ids = [];
      for (const f of built.files) {
        const id = await chrome.downloads.download({ url: f.url, filename: f.filename, conflictAction: 'uniquify', saveAs: false });
        pendingDownloads.add(id);
        ids.push(id);
      }
      const entry = {
        id: ids[0], name: built.files[0].filename, format: settings.format,
        parts: built.files.length, at: Date.now(),
      };
      const recent = [entry, ...store.recent.filter((r) => r.id !== entry.id)].slice(0, 5);
      await chrome.storage.local.set({ recent });
      result = {
        filename: entry.name, parts: entry.parts, count,
        milestone: now?.name || null, newMilestone, truncated: cap.truncated,
      };
    }
    await chrome.storage.local.set({ count });

    update({ status: 'done', phase: 'done', pct: 100, label: 'Done', result, finishedAt: Date.now() });
    flashBadge('✓', '#2E9E6B');
  } catch (e) {
    if (usesScroll) await inTab(pageRestore).catch(() => {});
    if (e instanceof Cancelled) {
      update({ status: 'cancelled', finishedAt: Date.now() });
      chrome.action.setBadgeText({ text: '' });
    } else {
      update({ status: 'error', error: friendlyError(e, job.url), finishedAt: Date.now() });
      flashBadge('!', '#E05555');
    }
  } finally {
    maybeCloseOffscreen();
  }
}
