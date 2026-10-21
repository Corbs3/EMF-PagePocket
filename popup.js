const $ = (id) => document.getElementById(id);
const IS_MAC = /Mac/i.test(navigator.userAgent);

let settings = { ...PP_DEFAULTS };
let clip = null;          // pending clipboard copy
let lastStatus = null;

// ── Copy (fun bits) ────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12)  return ['Good morning!',   pick(['Ready to pocket something?', 'What are we saving today?', 'Fresh pocket, ready to go'])];
  if (h >= 12 && h < 17) return ['Good afternoon!', pick(['Ready to pocket something?', 'Got a page worth keeping?', 'The pocket is open'])];
  if (h >= 17 && h < 22) return ['Good evening!',   pick(['One more for the pocket?', 'Tucking away a last one?', 'Still room in here'])];
  return ['Up late?', pick(["I'm awake if you are", 'Night owl pocketing mode'])];
}

const BUSY_SUB = {
  start:   'Getting my pocket ready',
  preload: 'Loading the page first',
  section: 'Scrolling down the page for you',
  stitch:  'Nearly there',
  save:    'Nearly there',
};

const SAVED_SUB = ["That one's safely tucked away", 'Snug as a page in a pocket', 'Another one for the collection'];

// ── Pocket pal ─────────────────────────────────────────────────────
function palSvg(mood) {
  const ink = '#1A6B47';
  const eyes = {
    idle:    `<circle cx="52" cy="38" r="5" fill="${ink}"/><circle cx="76" cy="38" r="5" fill="${ink}"/><circle cx="54" cy="36" r="1.6" fill="#fff"/><circle cx="78" cy="36" r="1.6" fill="#fff"/>`,
    busy:    `<circle cx="52" cy="38" r="5" fill="${ink}"/><circle cx="76" cy="38" r="5" fill="${ink}"/><circle cx="54.5" cy="40" r="1.6" fill="#fff"/><circle cx="78.5" cy="40" r="1.6" fill="#fff"/>`,
    saved:   `<circle cx="52" cy="38" r="5" fill="${ink}"/><path d="M71 38 Q76 33 81 38" stroke="${ink}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    puzzled: `<circle cx="52" cy="39" r="4.5" fill="${ink}"/><circle cx="76" cy="39" r="4.5" fill="${ink}"/><path d="M46 29 L57 31" stroke="${ink}" stroke-width="3" stroke-linecap="round"/><path d="M71 29 Q77 25 82 29" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  }[mood];
  const mouth = {
    idle:    `<path d="M55 49 Q64 58 73 49" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`,
    busy:    `<ellipse cx="64" cy="52" rx="4" ry="3.5" fill="${ink}"/>`,
    saved:   `<path d="M53 48 Q64 62 75 48 Z" fill="${ink}"/>`,
    puzzled: `<path d="M56 54 Q60 50 64 54 Q68 58 72 54" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`,
  }[mood];
  const tilt = mood === 'busy' ? 4 : mood === 'puzzled' ? -10 : -6;
  const lift = mood === 'saved' ? 8 : 0;
  return `<svg class="pal" id="pal" viewBox="0 0 128 128">
    <g transform="translate(0 ${lift}) rotate(${tilt} 64 50)">
      <rect x="36" y="14" width="56" height="64" rx="9" fill="#F7FCF9" stroke="#2E9E6B" stroke-width="2"/>
      ${eyes}
      <ellipse cx="45" cy="49" rx="5" ry="3" fill="#F6A8A0" opacity=".8"/><ellipse cx="83" cy="49" rx="5" ry="3" fill="#F6A8A0" opacity=".8"/>
      ${mouth}
    </g>
    <path d="M22 62H106V88Q106 110 84 110H44Q22 110 22 88Z" fill="#2E9E6B"/>
    <path d="M30 70H98V87Q98 102 83 102H45Q30 102 30 87Z" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="5 5" stroke-linecap="round"/>
  </svg>`;
}

function setPal(mood, anim) {
  $('palWrap').innerHTML = palSvg(mood);
  if (anim) $('pal').classList.add(anim);
}

function setHero(title, sub) {
  $('greet').textContent = title;
  $('sub').textContent = sub;
}

async function setChip(extra) {
  const { count } = await chrome.storage.local.get({ count: 0 });
  const m = ppMilestoneFor(count);
  let text = `${count} ${count === 1 ? 'page' : 'pages'} pocketed`;
  if (extra) text = extra;
  else if (m) text += `, ${m.name}`;
  $('chip').textContent = text;
}

function confetti() {
  const box = $('confetti');
  box.textContent = '';
  const colours = ['#2E9E6B', '#F6A8A0', '#F0C67E', '#6FA8EA', '#9FDDBF'];
  for (let i = 0; i < 26; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 310}px`;
    p.style.background = colours[i % colours.length];
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
  setTimeout(() => { box.textContent = ''; }, 3200);
}

// ── Views ──────────────────────────────────────────────────────────
function showView(name) {
  for (const v of ['ready', 'busy', 'done', 'error']) $(`${v}View`).hidden = v !== name;
  $('hint').hidden = name !== 'ready';
}

function showReady() {
  showView('ready');
  const [t, s] = greeting();
  setHero(t, s);
  setPal('idle');
  setChip();
}

function showBusy(j) {
  showView('busy');
  setHero(j.paused ? 'Wait for me!' : 'Hold tight...', j.paused ? "You've wandered off to another tab" : (BUSY_SUB[j.phase] || 'Working on it'));
  if (lastStatus !== 'running' || j.paused) setPal(j.paused ? 'puzzled' : 'busy', j.paused ? null : 'wiggle');
  $('progBar').style.width = `${j.pct || 0}%`;
  $('progWrap').setAttribute('aria-valuenow', String(j.pct || 0));
  $('progLabel').textContent = j.label || 'Working...';
  $('busyNote').hidden = j.target === 'clipboard';
}

function showDone(j, celebrate) {
  const r = j.result || {};
  showView('done');
  setHero('Pocketed!', pick(SAVED_SUB));
  setPal('saved', celebrate ? 'pop' : null);
  const note = $('doneNote');
  note.textContent = '';
  const b = document.createElement('b');
  const line = document.createElement('div');
  if (j.target === 'clipboard') {
    b.textContent = 'Copied to clipboard';
    line.textContent = `Paste it anywhere with ${IS_MAC ? 'Cmd+V' : 'Ctrl+V'}.`;
  } else {
    b.textContent = 'Saved to Downloads';
    line.className = 'fname';
    line.textContent = r.parts > 1 ? `${r.filename} and ${r.parts - 1} more part${r.parts > 2 ? 's' : ''} (it was a long one!)` : r.filename;
  }
  note.append(b, line);
  if (r.truncated) {
    const t = document.createElement('div');
    t.style.marginTop = '4px';
    t.textContent = 'This page goes on and on, so I pocketed the first part.';
    note.appendChild(t);
  }
  setChip(r.newMilestone ? `New badge: ${r.newMilestone}!` : null);
  if (celebrate) confetti();
  renderRecent();
}

function showError(message) {
  showView('error');
  setHero('Hmm...', "That didn't quite work");
  setPal('puzzled');
  const note = $('errorNote');
  note.textContent = '';
  const b = document.createElement('b');
  b.textContent = "Couldn't pocket this page";
  const line = document.createElement('div');
  line.textContent = message || 'Something went wrong. Please try again.';
  note.append(b, line);
  setChip();
}

// ── Recent pockets ─────────────────────────────────────────────────
async function renderRecent() {
  const { recent } = await chrome.storage.local.get({ recent: [] });
  const list = $('recentList');
  list.textContent = '';
  if (!recent.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing pocketed yet. Your first one will show up here.';
    list.appendChild(e);
    return;
  }
  const tagClass = { pdf: 'f-pdf', png: 'f-png', jpeg: 'f-jpg' };
  for (const r of recent.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'item';
    const tag = document.createElement('span');
    tag.className = `tag ${tagClass[r.format] || 'f-pdf'}`;
    tag.textContent = r.format === 'jpeg' ? 'JPEG' : (r.format || 'pdf').toUpperCase();
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name.replace(/(_\d{4}-\d{2}-\d{2})?(_part\d+)?(\s\(\d+\))?\.(pdf|png|jpg)$/i, '').replace(/_/g, ' ');
    name.title = r.name;
    const btn = document.createElement('button');
    btn.className = 'show';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', `Show ${r.name} in folder`);
    btn.addEventListener('click', async () => {
      const [item] = await chrome.downloads.search({ id: r.id });
      if (item?.exists && item.state === 'complete') {
        chrome.downloads.show(r.id);
      } else {
        const gone = document.createElement('span');
        gone.className = 'gone';
        gone.textContent = 'Moved or deleted';
        btn.replaceWith(gone);
      }
    });
    row.append(tag, name, btn);
    list.appendChild(row);
  }
}

// ── Settings ───────────────────────────────────────────────────────
function bindGroup(groupId, key, parse = (v) => v) {
  const buttons = $(groupId).querySelectorAll('button');
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(parse(b.dataset.value) === settings[key])));
  buttons.forEach((b) => b.addEventListener('click', () => {
    if (b.closest('.row.off')) return;
    settings[key] = parse(b.dataset.value);
    sync();
    applyRules();
    chrome.storage.local.set({ settings });
  }));
  sync();
}

function applyRules() {
  const qualityOff = settings.format === 'png';
  const methodOff = settings.mode === 'visible';
  $('qualityRow').classList.toggle('off', qualityOff);
  $('methodRow').classList.toggle('off', methodOff);
  $('qualityRow').title = qualityOff ? 'PNG is always full quality' : '';
  $('methodRow').title = methodOff ? 'Visible area always uses a screenshot' : '';
  $('qualityGroup').querySelectorAll('button').forEach((b) => { b.disabled = qualityOff; });
  $('methodGroup').querySelectorAll('button').forEach((b) => { b.disabled = methodOff; });
}

// ── Actions ────────────────────────────────────────────────────────
async function start(target) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return showError('No tab found to pocket.');

  if (target === 'clipboard') {
    // Start the clipboard write now, while we still have the click, and fill it in when the image is ready
    let resolve, reject;
    const blobPromise = new Promise((res, rej) => { resolve = res; reject = rej; });
    clip = { resolve, reject };
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
      .then(() => { clip?.onDone?.(); })
      .catch((e) => { if (clip) { clip = null; showError(e?.message?.includes('too long') ? e.message : "I couldn't copy that. Try saving it as a PNG instead."); } });
  }

  const res = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, target, settings });
  if (!res?.ok) {
    if (clip) { clip.reject(new Error(res?.error)); clip = null; }
    showError(res?.error);
  }
}

async function handleJob(j, fresh) {
  if (!j) return showReady();
  if (j.status === 'running') {
    showBusy(j);
  } else if (j.status === 'done') {
    if (j.target === 'clipboard') {
      if (clip && j.result?.clipUrl) {
        const c = clip;
        c.onDone = () => { clip = null; chrome.runtime.sendMessage({ type: 'clipboard-done' }); showDone(j, true); };
        try {
          const blob = await (await fetch(j.result.clipUrl)).blob();
          c.resolve(blob);
        } catch (_) {
          c.reject(new Error('fetch failed'));
        }
      } else if (!fresh) {
        showReady();
      }
    } else {
      showDone(j, fresh);
    }
  } else if (j.status === 'error') {
    if (clip) { clip.reject(new Error(j.error)); clip = null; }
    showError(j.error);
  } else {
    if (clip) { clip.reject(new Error('cancelled')); clip = null; }
    showReady();
  }
  lastStatus = j.status;
}

// ── Init ───────────────────────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get({ settings: PP_DEFAULTS });
  settings = { ...PP_DEFAULTS, ...stored.settings };

  bindGroup('modeGroup', 'mode');
  bindGroup('formatGroup', 'format');
  bindGroup('methodGroup', 'method');
  bindGroup('qualityGroup', 'quality', parseFloat);
  applyRules();

  const hint = $('hint');
  hint.textContent = 'Need just part of a page? Try ';
  for (const k of IS_MAC ? ['⌘', '⇧', '4'] : ['Win', 'Shift', 'S']) {
    const el = document.createElement('kbd');
    el.textContent = k;
    hint.append(el, ' ');
  }

  $('pocketBtn').addEventListener('click', () => start('download'));
  $('copyBtn').addEventListener('click', () => start('clipboard'));
  $('cancelBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cancel' }));
  $('againBtn').addEventListener('click', showReady);
  $('retryBtn').addEventListener('click', showReady);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'job') handleJob(msg.job, true);
  });

  renderRecent();
  const { job } = await chrome.runtime.sendMessage({ type: 'get-job' }) || {};
  const recent = job?.finishedAt && Date.now() - job.finishedAt < 15000;
  if (job?.status === 'running') handleJob(job, true);
  else if (recent && job.status === 'done' && job.target !== 'clipboard') showDone(job, false);
  else if (recent && job.status === 'error') showError(job.error);
  else showReady();
}

init();
