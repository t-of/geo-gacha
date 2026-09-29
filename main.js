'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'geo-gacha.' で始める。
const STORE = 'geo-gacha.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'geo-gacha', text: '1 日 1 回、9 マスの幾何学模様をひいて集める試作アプリ。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
//
// 1 枚の絵 = 正方形を 3×3 に分けた 9 マス。各マスは「背景色」と「パーツ（種類・向き・色）」を持つ。
// 絵はシード（32bit を 2 つ = 64bit の16進文字列）だけから決まる（splitmix64 で 9 マス分の乱数を引く）。
// 同じシードなら誰の端末でも同じ絵になる。

const DEBUG = new URLSearchParams(location.search).has('debug');

// ---------- 乱数（シードから決定的に） ----------
const MASK64 = (1n << 64n) - 1n;

function splitmix64(seedHex) {
  let state = BigInt('0x' + seedHex) & MASK64;
  return () => {
    state = (state + 0x9E3779B97F4A7C15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
}
function randInt(next, max) { return Number(next() % BigInt(max)); }

function newSeed() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(16).padStart(8, '0') + a[1].toString(16).padStart(8, '0');
}
function formatSeed(seedHex) {
  return 'No. ' + seedHex.match(/.{1,4}/g).join('-').toUpperCase();
}

// ---------- 絵（SVG） ----------
// 8 色（紺・クリーム・黄・朱・青・緑・赤・紫）× 10 種のパーツ × 4 向き。パーツは色が背景と同じだと消えて見える（それも個性）。
const PALETTE = ['#16182B', '#F4EEE1', '#F2B632', '#E4573D', '#2F57E0', '#1E9E6A', '#DB3A34', '#7446D8'];
const PARTS = ['empty', 'square', 'circle', 'ring', 'dot', 'quarter', 'half', 'triangle', 'stripe', 'diamond'];

function partMarkup(type, color, bg) {
  switch (type) {
    case 'square': return `<rect x="-28" y="-28" width="56" height="56" fill="${color}"/>`;
    case 'circle': return `<circle r="32" fill="${color}"/>`;
    case 'ring': return `<circle r="34" fill="${color}"/><circle r="17" fill="${bg}"/>`;
    case 'dot': return `<circle r="11" fill="${color}"/>`;
    case 'quarter': return `<path d="M-40,-40 H40 A80,80 0 0,1 -40,40 Z" fill="${color}"/>`;
    case 'half': return `<path d="M-40,0 A40,40 0 0,1 40,0 Z" fill="${color}"/>`;
    case 'triangle': return `<path d="M-40,-40 L40,-40 L-40,40 Z" fill="${color}"/>`;
    case 'stripe': return `<rect x="-40" y="-8" width="80" height="16" fill="${color}"/>`;
    case 'diamond': return `<rect x="-24" y="-24" width="48" height="48" fill="${color}" transform="rotate(45)"/>`;
    default: return ''; // empty
  }
}

function cellsFromSeed(seedHex) {
  const next = splitmix64(seedHex);
  return Array.from({ length: 9 }, () => ({
    bg: PALETTE[randInt(next, PALETTE.length)],
    part: PARTS[randInt(next, PARTS.length)],
    rot: randInt(next, 4),
    color: PALETTE[randInt(next, PALETTE.length)],
  }));
}

// シードだけから決定的に SVG を組む。viewBox は常に 0 0 300 300（1 マス 100×100）で、表示側の大きさは CSS に任せる。
function artSVG(seedHex) {
  const cells = cellsFromSeed(seedHex);
  let body = '';
  cells.forEach((cell, i) => {
    const cx = (i % 3) * 100, cy = Math.floor(i / 3) * 100;
    const inner = partMarkup(cell.part, cell.color, cell.bg);
    body += `<g transform="translate(${cx},${cy})">`
      + `<rect width="100" height="100" fill="${cell.bg}"/>`
      + (inner ? `<g transform="translate(50,50) rotate(${cell.rot * 90})">${inner}</g>` : '')
      + `</g>`;
  });
  body += `<path d="M100,0 V300 M200,0 V300 M0,100 H300 M0,200 H300" stroke="#16182B" stroke-width="2"/>`;
  return `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// ---------- 保存データ ----------
// geo-gacha.collection: { seed: 16桁 hex, at: ISO 日時 }[]（入手した順）
function loadCollection() { return load('collection', []); }
function saveCollection(list) { save('collection', list); }

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function drawnToday(collection) {
  const last = collection[collection.length - 1];
  return !!last && localDateStr(new Date(last.at)) === localDateStr();
}
function msUntilNextDay() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next - now;
}
function formatWait(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `あと ${h} 時間 ${m} 分`;
}

// ---------- 画面 ----------
const $ = (id) => document.getElementById(id);
const todayArt = $('todayArt'), todayNo = $('todayNo'), drawBtn = $('drawBtn'), todayMsg = $('todayMsg');
const gallery = $('gallery'), galleryCount = $('galleryCount');
const viewer = $('viewer'), viewerArt = $('viewerArt'), viewerNo = $('viewerNo'), viewerDate = $('viewerDate'), viewerClose = $('viewerClose');

function openViewer(item) {
  viewerArt.innerHTML = artSVG(item.seed);
  viewerNo.textContent = formatSeed(item.seed);
  viewerDate.textContent = localDateStr(new Date(item.at)) + ' に入手';
  viewer.hidden = false;
}
viewerClose.addEventListener('click', () => { viewer.hidden = true; });
viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.hidden = true; });

drawBtn.addEventListener('click', () => {
  const collection = loadCollection();
  if (drawnToday(collection) && !DEBUG) return;
  collection.push({ seed: newSeed(), at: new Date().toISOString() });
  saveCollection(collection);
  render();
});

function render() {
  const collection = loadCollection();
  galleryCount.textContent = collection.length ? `（${collection.length} 枚）` : '';

  const last = collection[collection.length - 1];
  const already = drawnToday(collection);
  if (last && already) {
    todayArt.innerHTML = artSVG(last.seed);
    todayNo.textContent = formatSeed(last.seed);
    todayNo.hidden = false;
  } else {
    todayArt.innerHTML = '<div class="today__placeholder">?</div>';
    todayNo.hidden = true;
  }

  if (already && !DEBUG) {
    drawBtn.hidden = true;
    todayMsg.hidden = false;
    todayMsg.textContent = `今日はもう引きました。また明日（${formatWait(msUntilNextDay())}）`;
  } else {
    drawBtn.hidden = false;
    todayMsg.hidden = true;
  }

  gallery.innerHTML = '';
  collection.slice().reverse().forEach((item) => {
    const cell = document.createElement('div');
    cell.className = 'gallery__item';
    cell.innerHTML = artSVG(item.seed);
    cell.addEventListener('click', () => openViewer(item));
    gallery.appendChild(cell);
  });
}

render();
