'use strict';

const MIN_PAIRS = 12;
const MAX_PAIRS = 36;
const THUMB_SIZE = 480;
const MISS_DELAY = 1200;
const STORE_KEY = 'memory-eh:v1';

// 36 Farbtöne rund um den Farbkreis (OKLCH, gleiche Helligkeit/Sättigung)
const PALETTE = [
  '#e8809a', '#ea808a', '#eb827b', '#ea856c', '#e8895d', '#e58f51',
  '#e39849', '#e1a447', '#deb14a', '#d7bc50', '#cac155', '#b6c259',
  '#9ebf5f', '#86bd67', '#6fbd73', '#58bd81', '#40be90', '#21bfa0',
  '#08beaf', '#08bcbc', '#09bac9', '#0bb8d6', '#22b5e1', '#3fb1ea',
  '#56acf0', '#6aa7f4', '#7ca2f6', '#8d9df5', '#9d98f2', '#ab93ed',
  '#b88fe6', '#c38adc', '#cd87d1', '#d684c5', '#de82b7', '#e380a9',
];
const VIOLET = '#ab93ed';
const ORANGE = '#e58f51';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const app = $('#app');
const grid = $('.grid');
const board = $('.board');
const photosEl = $('.photos');
const infoEl = $('.info');
const startBtn = $('.start');
const fileInput = $('.file');
const resetBtn = $('.reset');
const overlay = $('.overlay');
const sheet = $('.sheet');

/* ---------- State ---------- */

const state = {
  players: [
    { name: 'Elisa', color: VIOLET, score: 0 },
    { name: 'Hanna', color: ORANGE, score: 0 },
  ],
  turn: 0,
  starter: 0,
  screen: 'setup',
  deck: [],   // image id per card
  owner: [],  // player index per card, or -1
};

let images = [];        // [{ id, blob, url, added }]
let open = [];          // indices of currently flipped, unmatched cards
let missTimer = null;
let busy = false;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      players: state.players,
      turn: state.turn,
      starter: state.starter,
      screen: state.screen,
      deck: state.deck,
      owner: state.owner,
    }));
  } catch {}
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!s) return;
    if (Array.isArray(s.players) && s.players.length === 2) {
      s.players.forEach((p, i) => {
        if (typeof p.name === 'string' && p.name) state.players[i].name = p.name;
        if (PALETTE.includes(p.color)) state.players[i].color = p.color;
        state.players[i].score = Number(p.score) || 0;
      });
    }
    state.turn = s.turn === 1 ? 1 : 0;
    state.starter = s.starter === 1 ? 1 : 0;
    state.screen = s.screen === 'game' ? 'game' : 'setup';
    state.deck = Array.isArray(s.deck) ? s.deck : [];
    state.owner = Array.isArray(s.owner) ? s.owner : [];
  } catch {}
}

/* ---------- Image storage (IndexedDB) ---------- */

const db = (() => {
  let conn;
  const open = () => conn ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('memory-eh', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('images', mode);
      const req = fn(tx.objectStore('images'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  const safe = (p, fallback) => p.catch(() => fallback);
  return {
    all: () => safe(run('readonly', s => s.getAll()), []),
    put: rec => safe(run('readwrite', s => s.put(rec))),
    del: id => safe(run('readwrite', s => s.delete(id))),
    clear: () => safe(run('readwrite', s => s.clear())),
  };
})();

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(w, h);
    const out = Math.min(THUMB_SIZE, s);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = out;
    canvas.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, out, out);
    return await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addFiles(files) {
  const room = MAX_PAIRS - images.length;
  const list = [...files].slice(0, room);
  const skipped = files.length - list.length;
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    infoEl.textContent = `Lade Bild ${i + 1} von ${list.length} …`;
    const blob = await shrink(list[i]);
    if (!blob) { failed++; continue; }
    const rec = { id: uid(), blob, added: Date.now() + i };
    await db.put(rec);
    images.push({ ...rec, url: URL.createObjectURL(blob) });
    renderPhotos();
  }
  renderPhotos();
  const notes = [];
  if (skipped > 0) notes.push(`${skipped} ${skipped === 1 ? 'Bild' : 'Bilder'} über dem Maximum von ${MAX_PAIRS} ignoriert`);
  if (failed > 0) notes.push(`${failed} ${failed === 1 ? 'Bild konnte' : 'Bilder konnten'} nicht geladen werden`);
  if (notes.length) infoEl.textContent = notes.join(' · ');
}

function replaceAllImages() {
  if (busy) return;
  // Picker muss synchron im Tap-Handler geöffnet werden (iOS), DB wird danach geleert
  images.forEach(im => URL.revokeObjectURL(im.url));
  images = [];
  renderPhotos();
  fileInput.click();
  db.clear();
}

async function removeImage(id) {
  const i = images.findIndex(im => im.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(images[i].url);
  images.splice(i, 1);
  await db.del(id);
  renderPhotos();
}

/* ---------- Theme & players ---------- */

function applyTheme() {
  const root = document.documentElement.style;
  root.setProperty('--p0', state.players[0].color);
  root.setProperty('--p1', state.players[1].color);
  const active = state.screen === 'game' ? state.turn : state.starter;
  root.setProperty('--c', state.players[active].color);
  $$('.player').forEach(el => el.classList.toggle('active', Number(el.dataset.p) === active));
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
}

function renderPlayers() {
  $$('.player').forEach(el => {
    const p = state.players[el.dataset.p];
    const name = $('.name', el);
    if (name.contentEditable !== 'true') name.textContent = p.name;
    $('.score', el).textContent = p.score;
  });
  applyTheme();
}

function editName(el) {
  const i = Number(el.closest('.player').dataset.p);
  if (el.contentEditable === 'true') return;
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    el.removeEventListener('blur', finish);
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    const name = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 16);
    if (name) state.players[i].name = name;
    renderPlayers();
    save();
  };
  const onKey = e => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); el.blur(); }
  };
  el.addEventListener('blur', finish);
  el.addEventListener('keydown', onKey);
}

function pickColor(i) {
  const other = state.players[1 - i].color;
  sheet.innerHTML = `
    <h2></h2>
    <div class="swatches">
      ${PALETTE.map(c => `<button class="swatch" style="--sc:${c}" data-c="${c}" aria-label="Farbe"></button>`).join('')}
    </div>`;
  $('h2', sheet).textContent = `Farbe für ${state.players[i].name}`;
  $$('.swatch', sheet).forEach(b => {
    b.classList.toggle('selected', b.dataset.c === state.players[i].color);
    b.disabled = b.dataset.c === other;
    b.onclick = () => {
      state.players[i].color = b.dataset.c;
      renderPlayers();
      save();
      closeSheet();
    };
  });
  showSheet();
}

/* ---------- Sheets ---------- */

function showSheet(center = false) {
  overlay.classList.toggle('center', center);
  overlay.hidden = false;
}

function closeSheet() {
  overlay.hidden = true;
  sheet.innerHTML = '';
}

overlay.addEventListener('click', e => {
  if (e.target === overlay && !overlay.dataset.locked) closeSheet();
});

function openMenu() {
  sheet.innerHTML = `
    <div class="menu-list">
      <button data-a="again">Neu mischen</button>
      <button data-a="end">Spiel beenden</button>
      <button data-a="close">Weiterspielen</button>
    </div>`;
  $('[data-a="again"]', sheet).onclick = () => { closeSheet(); newGame(); };
  $('[data-a="end"]', sheet).onclick = () => { closeSheet(); toSetup(); };
  $('[data-a="close"]', sheet).onclick = closeSheet;
  showSheet();
}

function showResult() {
  const [a, b] = state.players;
  const winner = a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
  if (winner >= 0) document.documentElement.style.setProperty('--c', state.players[winner].color);
  sheet.innerHTML = `
    <h2></h2>
    <div class="result">${a.score} : ${b.score}</div>
    <button class="primary" data-a="again">Nochmal</button>
    <button class="text-btn" data-a="end">Spiel beenden</button>`;
  $('h2', sheet).textContent = winner < 0 ? 'Unentschieden!' : `${state.players[winner].name} gewinnt!`;
  $('[data-a="again"]', sheet).onclick = () => { closeSheet(); newGame(); };
  $('[data-a="end"]', sheet).onclick = () => { closeSheet(); toSetup(); };
  overlay.dataset.locked = '1';
  showSheet(true);
}

/* ---------- Setup screen ---------- */

const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const PHOTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>';

function renderPhotos() {
  const n = images.length;
  photosEl.classList.toggle('empty', n === 0);
  photosEl.innerHTML = '';
  for (const im of images) {
    const t = document.createElement('button');
    t.className = 'thumb';
    t.setAttribute('aria-label', 'Bild entfernen');
    t.innerHTML = `<img alt="" src="${im.url}">`;
    t.onclick = () => removeImage(im.id);
    photosEl.append(t);
  }
  if (n < MAX_PAIRS) {
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.innerHTML = n === 0 ? `${PHOTO}<span>Fotos auswählen</span>` : PLUS;
    pick.setAttribute('aria-label', 'Fotos hinzufügen');
    pick.onclick = () => fileInput.click();
    photosEl.append(pick);
  }
  if (n === 0) infoEl.textContent = `${MIN_PAIRS} bis ${MAX_PAIRS} Bilder`;
  else if (n < MIN_PAIRS) infoEl.textContent = `${n} Bilder · noch ${MIN_PAIRS - n} ${MIN_PAIRS - n === 1 ? 'fehlt' : 'fehlen'}`;
  else infoEl.textContent = `${n} Paare · ${n * 2} Karten`;
  startBtn.disabled = n < MIN_PAIRS;
  resetBtn.hidden = n === 0;
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length || busy) return;
  busy = true;
  startBtn.disabled = true;
  try { await addFiles(files); } finally { busy = false; startBtn.disabled = images.length < MIN_PAIRS; }
});

resetBtn.addEventListener('click', replaceAllImages);

startBtn.addEventListener('click', () => {
  if (images.length >= MIN_PAIRS && !busy) newGame();
});

function toSetup() {
  clearTimeout(missTimer);
  open = [];
  state.screen = 'setup';
  state.deck = [];
  state.owner = [];
  state.players.forEach(p => p.score = 0);
  app.dataset.screen = 'setup';
  renderPlayers();
  renderPhotos();
  save();
}

/* ---------- Game ---------- */

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newGame() {
  clearTimeout(missTimer);
  open = [];
  const wasPlaying = state.deck.length > 0;
  if (wasPlaying) state.starter = 1 - state.starter;
  const ids = images.slice(0, MAX_PAIRS).map(im => im.id);
  state.deck = shuffle([...ids, ...ids]);
  state.owner = state.deck.map(() => -1);
  state.players.forEach(p => p.score = 0);
  state.turn = state.starter;
  state.screen = 'game';
  delete overlay.dataset.locked;
  startGame();
  save();
}

function startGame() {
  app.dataset.screen = 'game';
  const urls = new Map(images.map(im => [im.id, im.url]));
  grid.innerHTML = '';
  state.deck.forEach((id, i) => {
    const card = document.createElement('button');
    card.className = 'card';
    card.dataset.i = i;
    card.innerHTML = `<div class="inner"><div class="face back"></div><div class="face front"><img alt="" draggable="false" src="${urls.get(id)}"></div></div>`;
    if (state.owner[i] >= 0) card.dataset.owner = state.owner[i];
    grid.append(card);
  });
  renderPlayers();
  layout();
}

function layout() {
  const n = state.deck.length;
  if (!n || state.screen !== 'game') return;
  const { width: W, height: H } = board.getBoundingClientRect();
  const gap = n > 40 ? 5 : n > 30 ? 6 : 8;
  let best = { size: 0, cols: 1 };
  for (let cols = 2; cols <= 12; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min((W - (cols - 1) * gap) / cols, (H - (rows - 1) * gap) / rows);
    if (size > best.size + 0.5) best = { size, cols };
  }
  const size = Math.floor(best.size);
  grid.style.setProperty('--size', `${size}px`);
  grid.style.setProperty('--gap', `${gap}px`);
  grid.style.setProperty('--w', `${best.cols * size + (best.cols - 1) * gap}px`);
}

const cardEl = i => grid.children[i];

function resolveMiss() {
  clearTimeout(missTimer);
  missTimer = null;
  open.forEach(i => cardEl(i).classList.remove('open'));
  open = [];
  state.turn = 1 - state.turn;
  renderPlayers();
  save();
}

grid.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (missTimer) { resolveMiss(); return; }
  const i = Number(card.dataset.i);
  if (state.owner[i] >= 0 || open.includes(i)) return;

  open.push(i);
  card.classList.add('open');
  if (open.length < 2) return;

  const [a, b] = open;
  if (state.deck[a] === state.deck[b]) {
    const who = state.turn;
    state.owner[a] = state.owner[b] = who;
    state.players[who].score++;
    open = [];
    setTimeout(() => {
      [a, b].forEach(k => {
        const el = cardEl(k);
        if (el) { el.dataset.owner = who; el.classList.remove('open'); }
      });
    }, 380);
    renderPlayers();
    save();
    if (state.owner.every(o => o >= 0)) setTimeout(showResult, 900);
  } else {
    missTimer = setTimeout(resolveMiss, MISS_DELAY);
  }
});

/* ---------- Header interactions ---------- */

$$('.player').forEach(el => {
  const i = Number(el.dataset.p);
  $('.name', el).addEventListener('click', e => editName(e.currentTarget));
  $('.dot', el).addEventListener('click', () => pickColor(i));
});

$('.menu-btn').addEventListener('click', openMenu);

addEventListener('resize', layout);
if (window.ResizeObserver) new ResizeObserver(layout).observe(board);

/* ---------- Boot ---------- */

(async function init() {
  load();
  const recs = await db.all();
  images = recs
    .sort((a, b) => a.added - b.added)
    .map(r => ({ ...r, url: URL.createObjectURL(r.blob) }));

  const known = new Set(images.map(im => im.id));
  const validGame = state.screen === 'game'
    && state.deck.length >= MIN_PAIRS * 2
    && state.deck.every(id => known.has(id))
    && state.owner.length === state.deck.length;

  if (validGame) {
    startGame();
    if (state.owner.every(o => o >= 0)) showResult();
  } else {
    state.screen = 'setup';
    state.deck = [];
    state.owner = [];
    state.players.forEach(p => p.score = 0);
    app.dataset.screen = 'setup';
    renderPlayers();
    renderPhotos();
  }
})();
