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

WebAppKit.init({ title: 'geo-gacha', text: '1 日 1 回、決まった場所に図形が並ぶ幾何学アートをひいて集める試作アプリ。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
//
// 1 枚の絵 = 正方形のキャンバスに、パッチールの斑点のように「決まった場所」へ図形を置いたもの。
// 場所・大きさは固定（下の SLOTS）。そこに何を置くか（図形の種類・向き・色、透明にするか）だけがシードで決まる。
// 絵はシード（32bit を 2 つ = 64bit の16進文字列）だけから決まる（splitmix64 で乱数を引く）。
// 同じシードなら誰の端末でも同じ絵になる。

// デモ版のあいだは何度でも引ける。1 日 1 回に戻すときは false にする。
const DEBUG = true;

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
// 8 色（紺・クリーム・黄・朱・青・緑・赤・紫）。図形の色は約 25% で「透明」（その場所には何も置かない）。
const PALETTE = ['#16182B', '#F4EEE1', '#F2B632', '#E4573D', '#2F57E0', '#1E9E6A', '#DB3A34', '#7446D8'];

// 図形は -40..40 の 80×80 を基準に作ってある。SLOTS の r（半径ぶんの大きさ）に合わせて r/40 倍で拡大縮小する。
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
    default: return ''; // empty（透明）
  }
}

// 場所・大きさ・重なり順（配列の順＝下から上）は固定。Bauhaus のポスターのような構図（大きな四分円の太陽、
// 横切る太い帯、色のブロック、同心円、三角と丸、回した四角の枠、下端に並ぶ小さな四角）。
// candidates はその場所に合う図形の候補（2〜4 個）で、そこから 1 つをシードで選ぶ。位置がキャンバス（0..1000）の
// 端に近いものは、向き次第で外にはみ出して切れる（パッチールの模様のように、はみ出しも個性のうち）。
const SLOTS = [
  { cx: 1000, cy: 0,   r: 340, candidates: ['quarter', 'half', 'circle'] },   // 右上の太陽
  { cx: 500,  cy: 380, r: 460, candidates: ['stripe'] },                      // 横切る太い帯
  { cx: 230,  cy: 760, r: 250, candidates: ['square', 'circle', 'quarter'] }, // 左下の大きなブロック
  { cx: 780,  cy: 640, r: 220, candidates: ['ring', 'square', 'circle'] },    // 右のブロック
  { cx: 780,  cy: 640, r: 90,  candidates: ['dot', 'circle'] },               // その中の小さい丸
  { cx: 230,  cy: 900, r: 170, candidates: ['triangle', 'half'] },           // 左下の三角
  { cx: 230,  cy: 900, r: 55,  candidates: ['dot', 'circle'] },               // 三角の中の丸
  { cx: 800,  cy: 880, r: 230, candidates: ['ring', 'quarter', 'circle'] },   // 右下の大きな同心円
  { cx: 800,  cy: 880, r: 120, candidates: ['ring', 'circle'] },              // その中の同心円
  { cx: 800,  cy: 880, r: 55,  candidates: ['dot'] },                        // 中心の点
  { cx: 150,  cy: 150, r: 70,  candidates: ['diamond', 'square'] },           // 左上の回した四角
  { cx: 650,  cy: 500, r: 420, candidates: ['stripe', 'dot'] },               // 縦に細い帯
  { cx: 110,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 下端に並ぶ小さな四角 1
  { cx: 210,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 2
  { cx: 310,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 3
  { cx: 410,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 4
];

// シードから、キャンバスの背景色と各スロットの中身（図形・向き・色）を決める。
function artFromSeed(seedHex) {
  const next = splitmix64(seedHex);
  const bgIdx = randInt(next, PALETTE.length);
  const bg = PALETTE[bgIdx];
  const shapes = SLOTS.map((slot) => {
    const transparent = randInt(next, 100) < 25; // 約 25% は置かない
    const part = slot.candidates[randInt(next, slot.candidates.length)];
    const rot = randInt(next, 4);
    let colorIdx = randInt(next, PALETTE.length);
    if (colorIdx === bgIdx) colorIdx = (colorIdx + 1) % PALETTE.length; // 背景と同色は隣の色にずらす（見えない図形を減らす）
    return { part: transparent ? 'empty' : part, rot, color: PALETTE[colorIdx] };
  });
  return { bg, shapes };
}

// シードだけから決定的に SVG を組む。viewBox は常に 0 0 1000 1000 で、表示側の大きさは CSS に任せる。
function artSVG(seedHex) {
  const { bg, shapes } = artFromSeed(seedHex);
  let body = `<rect width="1000" height="1000" fill="${bg}"/>`;
  shapes.forEach((shape, i) => {
    const slot = SLOTS[i];
    const inner = partMarkup(shape.part, shape.color, bg);
    if (!inner) return;
    body += `<g transform="translate(${slot.cx},${slot.cy}) rotate(${shape.rot * 90}) scale(${slot.r / 40})">${inner}</g>`;
  });
  return `<svg viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
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

// ---------- 音 ----------
let soundOn = load('sound', true), ctx = null;
const soundBtn = $('soundBtn');
function showSound() { soundBtn.textContent = soundOn ? '音 オン' : '音 オフ'; }
soundBtn.addEventListener('click', () => { soundOn = !soundOn; save('sound', soundOn); setAudioSession(soundOn); showSound(); });
showSound();

// ひいたときの短い上りの和音
function chime() {
  if (!soundOn) return;
  setAudioSession(true);
  ctx ??= new AudioContext();
  ctx.resume();
  [523, 659, 784, 1047].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.07;
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.4);
  });
}

drawBtn.addEventListener('click', () => {
  const collection = loadCollection();
  if (drawnToday(collection) && !DEBUG) return;
  chime();
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
