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
// 場所・大きさは固定（下の SLOTS）。そこに何を置くか（図形の種類・向き・色、透明にするか）だけが変わる。
// 番号（seed、16 進）は絵の中身をそのまま 1 つの数にしたもの。番号が同じ ⇔ 絵が同じ（1 対 1）。

// デモ版のあいだは何度でも引ける。1 日 1 回に戻すときは false にする。
const DEBUG = true;

// ---------- 乱数 ----------
function rand(max) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % max; // ponytail: max は 100 以下なので偏りは無視できる
}

function formatSeed(seedHex) {
  return 'No. ' + seedHex.padStart(SEED_LEN, '0').match(/.{1,4}/g).join('-').toUpperCase();
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
  { cx: 380,  cy: 190, r: 170, candidates: ['square', 'circle', 'quarter', 'half'] }, // 上中央のブロック
  { cx: 120,  cy: 430, r: 120, candidates: ['triangle', 'half', 'quarter'] }, // 左の中ほどの三角
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
  { cx: 380,  cy: 190, r: 70,  candidates: ['dot', 'circle', 'ring'] },       // 上中央のブロックの中の丸
  { cx: 560,  cy: 50,  r: 26,  candidates: ['square', 'dot'] },               // 上端に並ぶ小さな四角 1
  { cx: 640,  cy: 50,  r: 26,  candidates: ['square', 'dot'] },               // 2
  { cx: 720,  cy: 50,  r: 26,  candidates: ['square', 'dot'] },               // 3
  { cx: 800,  cy: 50,  r: 26,  candidates: ['square', 'dot'] },               // 4
  { cx: 650,  cy: 500, r: 420, candidates: ['stripe', 'dot'] },               // 縦に細い帯
  { cx: 110,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 下端に並ぶ小さな四角 1
  { cx: 210,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 2
  { cx: 310,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 3
  { cx: 410,  cy: 980, r: 32,  candidates: ['square', 'dot'] },               // 4
];

// 回しても見た目が変わらない図形は向きを 1 通りにする（帯は 2 通り）。同じ絵に 2 つの番号が付かないように。
const ROTS = { square: 1, circle: 1, ring: 1, dot: 1, diamond: 1, stripe: 2, quarter: 4, half: 4, triangle: 4 };
const COLORS = PALETTE.length - 1; // 図形の色は背景と同じ色を除いた 7 色
// スロットごとの選び方の数（透明 1 ＋ 図形×向き×色）と、全体の数（背景 8 色 × 各スロット）
const SLOT_OPTS = SLOTS.map((slot) => 1 + slot.candidates.reduce((n, t) => n + ROTS[t] * COLORS, 0));
const TOTAL = SLOT_OPTS.reduce((n, k) => n * BigInt(k), BigInt(PALETTE.length));
const SEED_LEN = Math.ceil((TOTAL - 1n).toString(16).length / 4) * 4;

// 新しい絵を 1 枚選び、番号にする。各スロットは約 25% で透明。
function newSeed() {
  let n = 0n;
  for (let i = SLOTS.length - 1; i >= 0; i--) {
    const slot = SLOTS[i];
    let v = 0; // 0 = 透明
    if (rand(100) >= 25) {
      const k = rand(slot.candidates.length);
      v = 1 + slot.candidates.slice(0, k).reduce((m, t) => m + ROTS[t] * COLORS, 0)
        + rand(ROTS[slot.candidates[k]]) * COLORS + rand(COLORS);
    }
    n = n * BigInt(SLOT_OPTS[i]) + BigInt(v);
  }
  n = n * BigInt(PALETTE.length) + BigInt(rand(PALETTE.length));
  return n.toString(16).padStart(SEED_LEN, '0');
}

// 番号から、背景色と各スロットの中身（図形・向き・色）を取り出す。newSeed の逆。
// 前の版の番号（16 桁）も TOTAL で割った余りとして読むので、どの番号も必ず絵になる。
function artFromSeed(seedHex) {
  let n = BigInt('0x' + seedHex) % TOTAL;
  const bgIdx = Number(n % BigInt(PALETTE.length));
  n /= BigInt(PALETTE.length);
  const shapes = SLOTS.map((slot, i) => {
    let v = Number(n % BigInt(SLOT_OPTS[i]));
    n /= BigInt(SLOT_OPTS[i]);
    if (v === 0) return { part: 'empty', rot: 0, color: PALETTE[0] };
    v -= 1;
    for (const t of slot.candidates) {
      const size = ROTS[t] * COLORS;
      if (v < size) {
        const k = v % COLORS;
        return { part: t, rot: Math.floor(v / COLORS), color: PALETTE[k < bgIdx ? k : k + 1] };
      }
      v -= size;
    }
  });
  return { bg: PALETTE[bgIdx], shapes };
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

// デモ用: どのスロットがどこにあるかの配置図。枠は各スロットの大きさ（cx±r）。
// 絵を渡すと、図形が置かれたスロットは実線、透明（置かれなかった）スロットは点線にする。
function slotMapSVG(seedHex) {
  const shapes = seedHex ? artFromSeed(seedHex).shapes : null;
  let body = '<rect width="1000" height="1000" fill="#1f2238"/>';
  SLOTS.forEach((slot, i) => {
    const used = !shapes || shapes[i].part !== 'empty';
    const color = shapes && used ? shapes[i].color : '#9aa0ab';
    body += `<rect x="${slot.cx - slot.r}" y="${slot.cy - slot.r}" width="${slot.r * 2}" height="${slot.r * 2}" fill="none" stroke="${color}" stroke-width="5"${used ? '' : ' stroke-dasharray="14 12"'}/>`;
    body += `<text x="${Math.min(Math.max(slot.cx, 30), 970)}" y="${Math.min(Math.max(slot.cy, 40), 985)}" fill="#eceef3" font-size="${slot.r < 60 ? 36 : 48}" font-weight="bold" text-anchor="middle" dominant-baseline="middle" paint-order="stroke" stroke="#1f2238" stroke-width="8">${i + 1}</text>`;
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
const todayArt = $('todayArt'), todayNo = $('todayNo'), drawBtn = $('drawBtn'), todayMsg = $('todayMsg'), todayMap = $('todayMap');
const gallery = $('gallery'), galleryCount = $('galleryCount');
const viewer = $('viewer'), viewerArt = $('viewerArt'), viewerNo = $('viewerNo'), viewerDate = $('viewerDate'), viewerClose = $('viewerClose');
const spotlight = $('spotlight'), frameWrap = $('frameWrap'), revealStage = $('revealStage');
const confirmDialog = $('confirmDialog'), confirmNo = $('confirmNo'), confirmYes = $('confirmYes');

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

function tone(freq, dur, t) {
  if (!soundOn) return;
  setAudioSession(true);
  ctx ??= new AudioContext();
  ctx.resume();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
}
// 図形が 1 つ出るたびの「ポン」。出てくるたびに音階が上がっていく。
const POP_SCALE = [523, 587, 659, 698, 784, 880, 988, 1047];
function playPop(i) {
  if (!soundOn) return;
  ctx ??= new AudioContext();
  tone(POP_SCALE[i % POP_SCALE.length] * (1 + Math.floor(i / POP_SCALE.length) * 0.5), 0.09, ctx.currentTime);
}
// そろったときのファンファーレ風の和音（低音を 1 つ足して少しゴージャスに）
function fanfare() {
  if (!soundOn) return;
  setAudioSession(true);
  ctx ??= new AudioContext();
  ctx.resume();
  [262, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.4, ctx.currentTime + i * 0.07));
}

// きらめき（光の粒）を額の中にいくつか散らす
function sparkle() {
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.style.left = `${8 + Math.random() * 84}%`;
    s.style.top = `${8 + Math.random() * 84}%`;
    s.style.animationDelay = `${Math.random() * 300}ms`;
    frameWrap.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }
}

// 番号を 1 文字ずつ出す（animate = false ならそのまま表示、ギャラリーを開いたときなど）
function showSeedText(seedHex, animate) {
  const text = formatSeed(seedHex);
  todayNo.hidden = false;
  todayNo.innerHTML = '';
  if (!animate) { todayNo.textContent = text; return; }
  [...text].forEach((ch, i) => {
    const span = document.createElement('span');
    span.textContent = ch === ' ' ? ' ' : ch;
    span.style.animationDelay = `${i * 35}ms`;
    todayNo.appendChild(span);
  });
}

// ---------- ひく演出 ----------
// 幕が上がる → スロットの並び順（下から上）で図形が 1 つずつポップして出る（大きいものほどゆっくり）→
// スポットライトが強まり、きらめきとファンファーレ、番号が 1 文字ずつ出る。タップでいつでも最後まで飛ばせる。
let revealTimers = [];
function afterMs(ms, fn) { revealTimers.push(setTimeout(fn, ms)); }
function clearRevealTimers() { revealTimers.forEach(clearTimeout); revealTimers = []; }

function playReveal(seedHex, onDone) {
  clearRevealTimers();
  const { bg, shapes } = artFromSeed(seedHex);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const curtain = revealStage.querySelector('.curtain');
  let finished = false;

  revealStage.hidden = false;
  curtain.classList.remove('curtain--up');
  spotlight.classList.remove('spotlight--bright');
  todayNo.hidden = true; todayNo.innerHTML = '';
  todayArt.innerHTML = `<svg viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1000" fill="${bg}"/><g id="revealLayers"></g></svg>`;
  const layers = $('revealLayers');

  function finishInstantly() {
    if (finished) return;
    finished = true;
    clearRevealTimers();
    revealStage.hidden = true;
    todayArt.innerHTML = artSVG(seedHex);
    spotlight.classList.add('spotlight--bright');
    showSeedText(seedHex, false);
    onDone();
  }
  revealStage.onclick = finishInstantly; // タップで最後まで飛ばす

  if (reduced) {
    afterMs(30, () => curtain.classList.add('curtain--up'));
    afterMs(320, () => {
      todayArt.innerHTML = artSVG(seedHex);
      spotlight.classList.add('spotlight--bright');
      showSeedText(seedHex, false);
      afterMs(400, finishInstantly);
    });
    return;
  }

  const visible = shapes.map((s, i) => ({ ...s, slot: SLOTS[i] })).filter((s) => s.part !== 'empty');

  afterMs(150, () => curtain.classList.add('curtain--up'));
  afterMs(700, () => {
    visible.forEach((s, vi) => {
      afterMs(vi * 90, () => {
        const dur = Math.max(220, Math.min(700, 260 + s.slot.r * 0.9));
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', `translate(${s.slot.cx},${s.slot.cy}) rotate(${s.rot * 90}) scale(${s.slot.r / 40})`);
        const inner = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        inner.setAttribute('class', 'reveal-shape');
        inner.style.animationDuration = `${dur}ms`;
        inner.innerHTML = partMarkup(s.part, s.color, bg);
        g.appendChild(inner);
        layers.appendChild(g);
        playPop(vi);
      });
    });
    afterMs(visible.length * 90 + 700, () => {
      spotlight.classList.add('spotlight--bright');
      sparkle();
      fanfare();
      showSeedText(seedHex, true);
      afterMs(900, finishInstantly);
    });
  });
}

// ---------- ひく（確認 → 演出） ----------
drawBtn.addEventListener('click', () => {
  const collection = loadCollection();
  if (drawnToday(collection) && !DEBUG) return;
  confirmDialog.showModal();
});
confirmNo.addEventListener('click', () => confirmDialog.close());
confirmYes.addEventListener('click', () => {
  confirmDialog.close();
  const collection = loadCollection();
  const seed = newSeed();
  collection.push({ seed, at: new Date().toISOString() });
  saveCollection(collection);
  drawBtn.hidden = true;
  todayMsg.hidden = true;
  playReveal(seed, () => render());
});

function render() {
  const collection = loadCollection();
  galleryCount.textContent = collection.length ? `（${collection.length} 枚）` : '';

  const last = collection[collection.length - 1];
  const already = drawnToday(collection);
  if (last && already) {
    todayArt.innerHTML = artSVG(last.seed);
    todayMap.innerHTML = slotMapSVG(last.seed);
    showSeedText(last.seed, false);
    spotlight.classList.add('spotlight--bright');
  } else {
    todayArt.innerHTML = '<div class="today__placeholder">?</div>';
    todayMap.innerHTML = slotMapSVG();
    todayNo.hidden = true;
    spotlight.classList.remove('spotlight--bright');
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
