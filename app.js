import { FilesetResolver, PoseLandmarker, ObjectDetector } from './vendor/vision_bundle.mjs';

const $ = (s, r = document) => r.querySelector(s);
const COL = { A: '#ff8a3d', B: '#3ec8ff', racket: '#ffe14d', skel: '#ffffff' };
const IS_MOBILE = matchMedia('(pointer:coarse)').matches;
const MAXSIDE = IS_MOBILE ? 560 : 860;   // 保存しておくコマ画像の長辺
const DETSIDE = 1280;                     // 解析に使う画像の長辺
const MAXDUR = 12;
// 打ち方ごとの設定：軌跡を残す長さ（秒）
const SHOTS = {
  stroke: { name: 'ストローク', trail: 0.6 },
  serve: { name: 'サーブ・スマッシュ', trail: 1.0 },
  volley: { name: 'ボレー', trail: 0.4 },
};

// MediaPipe の番号
const L = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lIdx: 19, rIdx: 20,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lToe: 31, rToe: 32 };
const BONES = [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30], [29, 31], [30, 32]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

const METRICS = [
  { key: 'speed', name: 'ヘッドの速さ', unit: '身長/秒', dec: 1 },
  { key: 'elbow', name: '肘の角度（利き腕）', unit: '°' },
  { key: 'kneeR', name: '右膝の角度', unit: '°' },
  { key: 'kneeL', name: '左膝の角度', unit: '°' },
  { key: 'lean', name: '体の前傾', unit: '°' },
  { key: 'tilt', name: '肩の傾き（利き腕側が下がると＋）', unit: '°' },
  { key: 'twist', name: '肩と腰のねじれ', unit: '°' },
  { key: 'wspeed', name: '手首の速さ', unit: '身長/秒', dec: 1 },
  { key: 'height', name: 'ヘッドの高さ（足首から・身長比）', unit: '身長比', dec: 2 },
];

/* ---------------- モデル ---------------- */
let vision, pose, det, poseKey = null, tsClock = 0;
async function withFallback(make) {
  try { return await make('GPU'); } catch (e) { console.warn('GPU不可→CPU', e); return await make('CPU'); }
}
async function ensureModels(quality, msg) {
  if (!vision) { msg('準備中…'); vision = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', location.href).href); }
  if (!pose || poseKey !== quality) {
    msg('体の動きを読むしくみを準備中…（初回は少し時間がかかります）');
    pose?.close();
    pose = await withFallback(d => PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `./models/pose_${quality}.task`, delegate: d },
      runningMode: 'VIDEO', numPoses: 2,
      minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    }));
    poseKey = quality;
  }
  if (!det) {
    msg('ラケットを探すしくみを準備中…');
    det = await withFallback(d => ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: './models/det.tflite', delegate: d },
      runningMode: 'IMAGE', scoreThreshold: 0.1, maxResults: 4, categoryAllowlist: ['tennis racket'],
    }));
  }
}

/* ---------------- 動画ごとの状態 ---------------- */
const clips = { A: newClip('A'), B: newClip('B') };
function newClip(id) {
  return { id, file: null, url: null, video: null, W: 0, H: 0, dur: 0, t0: 0, t1: 0, fps: 30,
    frames: [], ready: false, hand: 'auto', shot: 'stroke', side: 'R', handAuto: true, mirror: false,
    impact: 0, manual: {}, lm: [], wl: [], racket: [], m: [], bodyH: 1, torso: 1, busy: false, libId: null, title: '' };
}
const ready = () => ['A', 'B'].filter(k => clips[k].ready).map(k => clips[k]);

/* ---------------- カード（動画選び） ---------------- */
for (const id of ['A', 'B']) buildCard(id);
function buildCard(id) {
  const card = $('#card' + id), c = clips[id];
  card.append($('#cardTpl').content.cloneNode(true));
  $('.tag', card).textContent = id;
  $('.ttl', card).textContent = id === 'A' ? '動画A' : '動画B（比べる相手）';
  const drop = $('.drop', card), input = $('input', drop), prev = $('.prev', card), v = $('video', card);
  c.video = v; c.card = card;
  const libLink = $('.fromlib', card);
  libLink.onclick = () => $('#library').scrollIntoView({ behavior: 'smooth' });
  c.showEmpty = () => {
    card.classList.remove('lib'); drop.classList.remove('hidden'); prev.classList.add('hidden');
    libLink.classList.toggle('hidden', !libCount);
  };
  if (id === 'B') {
    $('.addB', card).onclick = () => { card.classList.remove('collapsed'); c.showEmpty(); };
    $('.x', card).classList.remove('hidden');
    $('.x', card).onclick = () => {
      reset(c); v.removeAttribute('src'); c.dur = 0; c.libId = null;
      $('.summary', card).classList.add('hidden'); c.status('');
      c.showEmpty(); card.classList.add('collapsed');
    };
  }
  drop.onclick = () => input.click();
  input.onchange = () => input.files[0] && load(input.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; f && load(f); };
  const status = (t, err) => { const s = $('.status', card); s.textContent = t; s.classList.toggle('err', !!err); };
  c.status = status;
  const rangeTxt = () => {
    const n = Math.floor((c.t1 - c.t0) * +$('#fps').value) + 1;
    $('.range', card).innerHTML = `解析する範囲 <b>${c.t0.toFixed(2)}〜${c.t1.toFixed(2)}秒</b>（${n}コマ）`;
  };
  $('#fps').addEventListener('change', () => c.dur && rangeTxt());
  function load(file) {
    if (!file.type.startsWith('video') && !/\.(mov|mp4|m4v|webm)$/i.test(file.name)) { status('動画ファイルを選んでください', true); return; }
    reset(c);
    if (c.url) URL.revokeObjectURL(c.url);
    c.file = file; c.url = URL.createObjectURL(file); c.libId = null; c.title = '';
    v.src = c.url;
    card.classList.remove('lib'); libLink.classList.add('hidden');
    drop.classList.add('hidden'); prev.classList.remove('hidden');
    $('.summary', card).classList.add('hidden');
    status('動画を読み込み中…');
    v.onloadedmetadata = () => {
      c.W = v.videoWidth; c.H = v.videoHeight; c.dur = v.duration;
      c.t0 = 0; c.t1 = Math.min(c.dur, MAXDUR);
      rangeTxt();
      status(c.dur > MAXDUR ? `長い動画なので最初の${MAXDUR}秒にしました。見たいスイングの前後で「開始」「終了」を決めてください。` : '「解析する」を押してください。');
    };
    v.onerror = () => status('この動画は開けませんでした。iPhoneの動画なら Safari で開くか、「互換性優先」で撮った動画を使ってください。', true);
  }
  $('.setIn', card).onclick = () => { c.t0 = Math.min(v.currentTime, c.t1 - 0.2); if (c.t1 - c.t0 > MAXDUR) c.t1 = c.t0 + MAXDUR; rangeTxt(); };
  $('.setOut', card).onclick = () => { c.t1 = Math.max(v.currentTime, c.t0 + 0.2); if (c.t1 - c.t0 > MAXDUR) c.t0 = c.t1 - MAXDUR; rangeTxt(); };
  $('.shot', card).onchange = e => {
    c.shot = e.target.value;
    if (c.ready) { autoImpact(c); summary(c); updateViewer(); setT(0); saveMeta(c); }
  };
  $('.hand', card).onchange = e => {
    c.hand = e.target.value;
    if (c.ready) { resolveHand(c); recompute(c, true); renderAll(); summary(c); saveMeta(c); }
  };
  $('.change', card).onclick = () => { input.value = ''; input.click(); };
  $('.go', card).onclick = () => analyze(c);
}
function reset(c) {
  c.frames.forEach(f => f.img?.close?.());
  Object.assign(c, { frames: [], ready: false, manual: {}, lm: [], wl: [], racket: [], m: [] });
  updateViewer();
}

/* ---------------- 解析 ---------------- */
function seek(v, t) {
  return new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; v.removeEventListener('seeked', on); res(); } };
    const on = () => {
      if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(() => fin()); setTimeout(fin, 150); }
      else fin();
    };
    v.addEventListener('seeked', on);
    setTimeout(fin, 3000);
    v.currentTime = t;
  });
}
async function analyze(c) {
  if (c.busy || !c.dur) return;
  c.busy = true;
  const card = c.card, bar = $('.bar', card), barI = $('.bar i', card), go = $('.go', card);
  go.disabled = true; bar.classList.remove('hidden'); barI.style.width = '0';
  try {
    await ensureModels($('#quality').value, t => c.status(t));
    reset(c);
    const v = c.video; v.pause();
    c.fps = +$('#fps').value;
    const n = Math.floor((c.t1 - c.t0) * c.fps) + 1;
    const sc = Math.min(1, MAXSIDE / Math.max(c.W, c.H));
    const img = document.createElement('canvas'); img.width = Math.round(c.W * sc); img.height = Math.round(c.H * sc);
    const ic = img.getContext('2d');
    const ds = Math.min(1, DETSIDE / Math.max(c.W, c.H));
    const dc = document.createElement('canvas'); dc.width = Math.round(c.W * ds); dc.height = Math.round(c.H * ds);
    const dx = dc.getContext('2d', { willReadFrequently: false });
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      const t = c.t0 + i / c.fps;
      await seek(v, Math.min(t, c.dur - 0.001));
      dx.drawImage(v, 0, 0, dc.width, dc.height);
      ic.drawImage(dc, 0, 0, img.width, img.height);
      const bmp = await createImageBitmap(img);
      const jpg = $('#autosave').checked ? await new Promise(r => img.toBlob(r, 'image/jpeg', 0.82)) : null;
      tsClock += 40;
      const r = pose.detectForVideo(dc, tsClock);
      const poses = r.landmarks.map((lm, k) => ({ lm: pack(lm, 4), wl: pack(r.worldLandmarks[k], 3) }));
      const d = det.detect(dc);
      const boxes = d.detections.map(x => {
        const b = x.boundingBox;
        return [b.originX / dc.width, b.originY / dc.height, b.width / dc.width, b.height / dc.height, x.categories[0].score];
      });
      c.frames.push({ t, img: bmp, jpg, poses, boxes });
      barI.style.width = ((i + 1) / n * 100).toFixed(1) + '%';
      if (i % 3 === 0) {
        const el = (performance.now() - started) / 1000, rest = el / (i + 1) * (n - i - 1);
        c.status(`解析中… ${i + 1} / ${n}コマ（あと約${Math.ceil(rest)}秒）`);
      }
    }
    postprocess(c);
    c.ready = true;
    c.status('');
    summary(c);
    updateViewer(true);
    if ($('#autosave').checked) {
      c.title = defaultTitle(c);
      await saveNew(c);
    }
  } catch (e) {
    console.error(e);
    c.status('解析できませんでした：' + (e.message || e), true);
  } finally {
    c.busy = false; go.disabled = false; bar.classList.add('hidden');
  }
}
function pack(lms, k) {
  const a = new Float32Array(33 * k);
  lms.forEach((p, i) => { a[i * k] = p.x; a[i * k + 1] = p.y; a[i * k + 2] = p.z; if (k === 4) a[i * k + 3] = p.visibility ?? 1; });
  return a;
}
function summary(c) {
  const s = $('.summary', c.card), n = c.frames.length;
  const body = c.lm.filter(Boolean).length, rk = c.racket.filter(r => r && r.kind === 'auto').length;
  const filled = c.racket.filter(Boolean).length;
  s.innerHTML = `解析ずみ：${n}コマ ／ 体 ${pct(body, n)} ／ ラケット ${pct(rk, n)}（補って ${pct(filled, n)}）<br>` +
    `打ち方：<b>${SHOTS[c.shot].name}</b>　利き手：<b>${c.side === 'R' ? '右' : '左'}</b>${c.hand === 'auto' ? '（自動判定）' : ''}　` +
    (rk / n < 0.3 ? '<span style="color:var(--warn)">ラケットが少ししか見つかりませんでした。「ヘッドの位置を直す」で補えます。</span>' : '');
  s.classList.remove('hidden');
}
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '-';

/* ---------------- 保存した動画（この端末のブラウザ内 IndexedDB） ---------------- */
const DB = (() => {
  let p;
  const open = () => p ??= new Promise((res, rej) => {
    const q = indexedDB.open('form-check', 1);
    q.onupgradeneeded = () => { q.result.createObjectStore('meta', { keyPath: 'id' }); q.result.createObjectStore('data', { keyPath: 'id' }); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  const tx = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode), r = fn(t);
      t.oncomplete = () => res(r ? r.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    list: () => tx(['meta'], 'readonly', t => t.objectStore('meta').getAll()),
    get: id => tx(['data'], 'readonly', t => t.objectStore('data').get(id)),
    putMeta: m => tx(['meta'], 'readwrite', t => { t.objectStore('meta').put(m); }),
    put: (m, d) => tx(['meta', 'data'], 'readwrite', t => { t.objectStore('meta').put(m); t.objectStore('data').put(d); }),
    del: id => tx(['meta', 'data'], 'readwrite', t => { t.objectStore('meta').delete(id); t.objectStore('data').delete(id); }),
  };
})();
let libCount = 0, libMetas = {};
const fmtDate = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
function defaultTitle(c) {
  const base = (c.file?.name || '動画').replace(/\.[^.]+$/, '');
  return `${SHOTS[c.shot].name} ${fmtDate(Date.now())}（${base}）`;
}
function metaOf(c, created) {
  return {
    id: c.libId, title: c.title, created: created ?? libMetas[c.libId]?.created ?? Date.now(),
    shot: c.shot, hand: c.hand, fps: c.fps, W: c.W, H: c.H, n: c.frames.length,
    dur: (c.frames.length - 1) / c.fps, impact: c.impact, manual: { ...c.manual },
    thumb: c.frames[c.impact]?.jpg || c.frames[0]?.jpg || null,
    bytes: c.frames.reduce((s, f) => s + (f.jpg?.size || 0), 0),
  };
}
async function saveNew(c) {
  if (c.frames.some(f => !f.jpg)) return;
  try {
    navigator.storage?.persist?.().catch(() => {});
    c.libId = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const data = { id: c.libId, frames: c.frames.map(f => ({ t: f.t, jpg: f.jpg, poses: f.poses, boxes: f.boxes })) };
    await DB.put(metaOf(c, Date.now()), data);
    await refreshLibrary();
  } catch (e) {
    console.error(e); c.libId = null;
    c.status('保存できませんでした（端末の空き容量が足りないかもしれません）。この動画はこのまま見られます。', true);
  }
}
// 直したところ（インパクト・ヘッドの修正・打ち方・利き手）を保存し直す
function saveMeta(c) {
  if (!c.libId) return;
  clearTimeout(c._saveT);
  c._saveT = setTimeout(async () => {
    try { await DB.putMeta(metaOf(c)); await refreshLibrary(); } catch (e) { console.error(e); }
  }, 600);
}
async function refreshLibrary() {
  let metas = [];
  try { metas = await DB.list(); } catch (e) { console.warn('保存先が使えません', e); }
  metas.sort((a, b) => b.created - a.created);
  libCount = metas.length; libMetas = Object.fromEntries(metas.map(m => [m.id, m]));
  $('#library').classList.toggle('hidden', !metas.length);
  for (const c of Object.values(clips)) if (c.card && !c.dur && !c.ready) $('.fromlib', c.card).classList.toggle('hidden', !libCount);
  const list = $('#libList');
  list.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src));
  list.innerHTML = '';
  for (const m of metas) {
    const el = document.createElement('div'); el.className = 'item';
    const img = document.createElement('img'); if (m.thumb) img.src = URL.createObjectURL(m.thumb);
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = m.title;
    const sp = document.createElement('span'); sp.textContent = `${fmtDate(m.created)} 保存 ・ ${SHOTS[m.shot]?.name || ''} ・ ${m.dur.toFixed(1)}秒`;
    meta.append(b, sp);
    const acts = document.createElement('div'); acts.className = 'acts';
    const btn = (t, cls, fn) => { const x = document.createElement('button'); x.textContent = t; x.className = cls; x.onclick = fn; acts.append(x); };
    btn('Aで見る', 'a', () => loadFromLib(m.id, 'A'));
    btn('Bで比べる', 'b', () => loadFromLib(m.id, 'B'));
    btn('名前', '', async () => {
      const t = prompt('名前（例：4月 フォア 横から）', m.title);
      if (t == null || !t.trim()) return;
      m.title = t.trim(); await DB.putMeta(m);
      for (const c of Object.values(clips)) if (c.libId === m.id) { c.title = m.title; showLibCard(c); }
      refreshLibrary();
    });
    btn('消す', 'del', async () => {
      if (!confirm(`「${m.title}」を消します。もとに戻せません。よろしいですか？`)) return;
      await DB.del(m.id);
      for (const c of Object.values(clips)) if (c.libId === m.id) c.libId = null;
      refreshLibrary();
    });
    el.append(img, meta, acts); list.append(el);
  }
  try {
    const est = await navigator.storage?.estimate?.();
    $('#libUsage').textContent = `${metas.length}本` + (est ? ` ・ 使用量 約${Math.round(est.usage / 1e6)}MB` : '');
  } catch { $('#libUsage').textContent = `${metas.length}本`; }
}
function showLibCard(c) {
  const card = c.card;
  card.classList.remove('collapsed'); card.classList.add('lib');
  $('.drop', card).classList.add('hidden'); $('.fromlib', card).classList.add('hidden'); $('.prev', card).classList.remove('hidden');
  $('.libname', card).innerHTML = '';
  const t = document.createElement('span'); t.className = 'range'; t.innerHTML = '保存した動画：<b></b>'; $('b', t).textContent = c.title;
  $('.libname', card).append(t);
  const still = $('.still', card), j = c.frames[c.impact]?.jpg;
  if (still.src) URL.revokeObjectURL(still.src);
  if (j) still.src = URL.createObjectURL(j);
  $('.shot', card).value = c.shot; $('.hand', card).value = c.hand;
}
async function loadFromLib(id, slot) {
  const c = clips[slot], m = libMetas[id];
  if (!m || c.busy) return;
  c.busy = true;
  c.card.classList.remove('collapsed');
  c.status('読み込み中…');
  try {
    const d = await DB.get(id);
    reset(c);
    c.video.pause(); c.video.removeAttribute('src'); c.file = null; c.dur = 0;
    Object.assign(c, { libId: id, title: m.title, shot: m.shot, hand: m.hand, fps: m.fps, W: m.W, H: m.H, manual: { ...m.manual } });
    c.frames = await Promise.all(d.frames.map(async f => ({ ...f, img: await createImageBitmap(f.jpg) })));
    c.t0 = c.frames[0].t; c.t1 = c.frames[c.frames.length - 1].t;
    postprocess(c);
    c.impact = Math.max(0, Math.min(c.frames.length - 1, m.impact));
    c.ready = true;
    showLibCard(c);
    c.status(''); summary(c);
    tRel = 0; updateViewer(true);
  } catch (e) {
    console.error(e); c.status('読み込めませんでした：' + (e.message || e), true);
  } finally { c.busy = false; }
}
refreshLibrary();

/* ---------------- 後処理 ---------------- */
const lmPx = (c, lm, k) => ({ x: lm[k * 4] * c.W, y: lm[k * 4 + 1] * c.H });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

function postprocess(c) {
  const F = c.frames;
  // 2人写っていても、同じ人を追いかける
  let prev = null;
  const sel = F.map(f => {
    if (!f.poses.length) return null;
    let best;
    if (!prev) {
      best = f.poses.map(p => [p, boxArea(p.lm)]).sort((a, b) => b[1] - a[1])[0][0];
    } else {
      best = f.poses.map(p => [p, dist(hipN(p.lm), prev)]).sort((a, b) => a[1] - b[1])[0][0];
    }
    prev = hipN(best.lm);
    return best;
  });
  c.lm = smooth(sel.map(p => p && p.lm), 4, 2);
  c.wl = smooth(sel.map(p => p && p.wl), 3, 3);
  c.bodyH = median(c.lm.map(lm => lm && dist(lmPx(c, lm, L.nose), mid(lmPx(c, lm, L.lAn), lmPx(c, lm, L.rAn))) / 0.87)) || c.H * 0.6;
  c.torso = median(c.lm.map(lm => lm && dist(mid(lmPx(c, lm, L.lSh), lmPx(c, lm, L.rSh)), mid(lmPx(c, lm, L.lHip), lmPx(c, lm, L.rHip))))) || c.H * 0.2;
  resolveHand(c);
  recompute(c, true);
}
const hipN = lm => ({ x: (lm[L.lHip * 4] + lm[L.rHip * 4]) / 2, y: (lm[L.lHip * 4 + 1] + lm[L.rHip * 4 + 1]) / 2 });
function boxArea(lm) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let i = 0; i < 33; i++) { const x = lm[i * 4], y = lm[i * 4 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return (x1 - x0) * (y1 - y0);
}
// 前後のコマと 1:2:1 で平均してガタつきをおさえる（xとyなど先頭 dims 個）
function smooth(seq, k, dims) {
  return seq.map((a, i) => {
    if (!a) return null;
    const o = a.slice(), p = seq[i - 1], q = seq[i + 1];
    for (let j = 0; j < 33; j++) for (let d = 0; d < dims; d++) {
      const idx = j * k + d; let s = a[idx] * 2, w = 2;
      if (p) { s += p[idx]; w++; } if (q) { s += q[idx]; w++; }
      o[idx] = s / w;
    }
    return o;
  });
}
function handPx(c, lm, side) {
  const [w, x] = side === 'R' ? [L.rWr, L.rIdx] : [L.lWr, L.lIdx];
  return mid(lmPx(c, lm, w), lmPx(c, lm, x));
}
function rectDist(p, b) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}
const boxPx = (c, b) => ({ x: b[0] * c.W, y: b[1] * c.H, w: b[2] * c.W, h: b[3] * c.H, s: b[4] });

function resolveHand(c) {
  if (c.hand !== 'auto') { c.side = c.hand; return; }
  let r = 0, l = 0;
  c.frames.forEach((f, i) => {
    const lm = c.lm[i]; if (!lm || !f.boxes.length) return;
    // 構えや休みで両手が近いコマは数えず、ラケットが体から離れているコマで決める
    const shM = mid(lmPx(c, lm, L.lSh), lmPx(c, lm, L.rSh));
    for (const b0 of f.boxes) {
      const b = boxPx(c, b0), ctr = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const away = dist(ctr, shM) / c.bodyH;
      if (away < 0.3) continue;
      const dR = rectDist(handPx(c, lm, 'R'), b), dL = rectDist(handPx(c, lm, 'L'), b);
      if (Math.abs(dR - dL) > c.bodyH * 0.06) dR < dL ? r += away : l += away;
    }
  });
  c.side = l > r ? 'L' : 'R';
}

// ラケットヘッド：手からいちばん遠い箱の角に向かって 78% の位置（面の真ん中あたり）
function autoHead(c, i) {
  const lm = c.lm[i], f = c.frames[i];
  if (!lm || !f.boxes.length) return null;
  const hand = handPx(c, lm, c.side);
  let best = null, bd = Infinity;
  for (const b0 of f.boxes) {
    const b = boxPx(c, b0), d = rectDist(hand, b) - b.s * c.bodyH * 0.05;
    if (d < bd) { bd = d; best = b; }
  }
  if (!best || rectDist(hand, best) > c.bodyH * 0.15) return null;
  const corners = [[best.x, best.y], [best.x + best.w, best.y], [best.x, best.y + best.h], [best.x + best.w, best.y + best.h]]
    .map(([x, y]) => ({ x, y }));
  const far = corners.sort((a, b) => dist(b, hand) - dist(a, hand))[0];
  const len = dist(far, hand);
  if (len < c.bodyH * 0.15 || len > c.bodyH * 0.65) return null;
  return { x: hand.x + (far.x - hand.x) * 0.78, y: hand.y + (far.y - hand.y) * 0.78 };
}
function computeRacket(c) {
  const n = c.frames.length, out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const man = c.manual[i];
    if (man === 'none') continue;
    if (man) { out[i] = { x: man.x * c.W, y: man.y * c.H, kind: 'manual' }; continue; }
    const h = autoHead(c, i);
    if (h) out[i] = { ...h, kind: 'auto' };
  }
  // とびはねた点をのぞく
  for (let i = 1; i < n - 1; i++) {
    const a = out[i - 1], b = out[i], d = out[i + 1];
    if (b && b.kind === 'auto' && a && d && dist(a, d) < c.bodyH * 0.2 && dist(b, mid(a, d)) > c.bodyH * 0.25) out[i] = null;
  }
  // 抜けたコマを、手からの向きで前後から補う
  const gapMax = Math.round(0.3 * c.fps);
  const known = out.map((r, i) => r && c.lm[i] ? i : -1).filter(i => i >= 0);
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k], b = known[k + 1];
    if (b - a <= 1) continue;
    const bothManual = out[a].kind === 'manual' && out[b].kind === 'manual';
    if (b - a - 1 > gapMax && !bothManual) continue;
    const ha = handPx(c, c.lm[a], c.side), hb = handPx(c, c.lm[b], c.side);
    const oa = { x: out[a].x - ha.x, y: out[a].y - ha.y }, ob = { x: out[b].x - hb.x, y: out[b].y - hb.y };
    // 長さと角度で補う（弧をえがくように）
    const ra = Math.hypot(oa.x, oa.y), rb = Math.hypot(ob.x, ob.y);
    const aa = Math.atan2(oa.y, oa.x); let ab = Math.atan2(ob.y, ob.x);
    while (ab - aa > Math.PI) ab -= 2 * Math.PI; while (ab - aa < -Math.PI) ab += 2 * Math.PI;
    for (let i = a + 1; i < b; i++) {
      if (out[i] || c.manual[i] === 'none' || !c.lm[i]) continue;
      const u = (i - a) / (b - a), r = ra + (rb - ra) * u, an = aa + (ab - aa) * u, h = handPx(c, c.lm[i], c.side);
      out[i] = { x: h.x + Math.cos(an) * r, y: h.y + Math.sin(an) * r, kind: 'interp' };
    }
  }
  // 自動の点だけ軽くならす
  c.racket = out.map((r, i) => {
    if (!r || r.kind === 'manual') return r;
    const p = out[i - 1], q = out[i + 1];
    let x = r.x * 2, y = r.y * 2, w = 2;
    if (p) { x += p.x; y += p.y; w++; } if (q) { x += q.x; y += q.y; w++; }
    return { x: x / w, y: y / w, kind: r.kind };
  });
}

const ang3 = (a, b, c) => {
  const v1 = Math.atan2(a.y - b.y, a.x - b.x), v2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(v1 - v2) * 180 / Math.PI; return d > 180 ? 360 - d : d;
};
const norm180 = d => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
function computeMetrics(c) {
  const n = c.frames.length, R = c.side === 'R';
  const sh = R ? L.rSh : L.lSh, el = R ? L.rEl : L.lEl, wr = R ? L.rWr : L.lWr, osh = R ? L.lSh : L.rSh;
  const speed = i => {
    const p = c.racket[i - 1], q = c.racket[i + 1];
    return p && q ? dist(p, q) * c.fps / 2 / c.bodyH : NaN;
  };
  const wspeed = i => {
    const p = c.lm[i - 1], q = c.lm[i + 1];
    return p && q ? dist(lmPx(c, p, wr), lmPx(c, q, wr)) * c.fps / 2 / c.bodyH : NaN;
  };
  const sm = (fn) => {   // 5コマの移動平均でとびはねをおさえる
    const raw = c.frames.map((_, i) => fn(i));
    return raw.map((_, i) => {
      let s = 0, w = 0;
      for (let d = -2; d <= 2; d++) { const v = raw[i + d]; if (Number.isFinite(v)) { s += v; w++; } }
      return Number.isFinite(raw[i]) && w ? s / w : NaN;
    });
  };
  const sp = sm(speed), wsp = sm(wspeed);
  c.m = c.lm.map((lm, i) => {
    if (!lm) return { speed: sp[i] };
    const P = k => lmPx(c, lm, k);
    const shM = mid(P(L.lSh), P(L.rSh)), hipM = mid(P(L.lHip), P(L.rHip));
    const w = c.wl[i], W = k => ({ x: w[k * 3], z: w[k * 3 + 2] });
    const yaw = (a, b) => Math.atan2(W(b).z - W(a).z, W(b).x - W(a).x) * 180 / Math.PI;
    const s = P(sh), o = P(osh);
    return {
      elbow: ang3(P(sh), P(el), P(wr)),
      kneeR: ang3(P(L.rHip), P(L.rKn), P(L.rAn)),
      kneeL: ang3(P(L.lHip), P(L.lKn), P(L.lAn)),
      lean: Math.atan2(Math.abs(shM.x - hipM.x), hipM.y - shM.y) * 180 / Math.PI,
      tilt: Math.atan2(s.y - o.y, Math.abs(s.x - o.x)) * 180 / Math.PI,
      twist: Math.abs(norm180(yaw(L.lSh, L.rSh) - yaw(L.lHip, L.rHip))),
      speed: sp[i], wspeed: wsp[i],
      height: c.racket[i] ? (mid(P(L.lAn), P(L.rAn)).y - c.racket[i].y) / c.bodyH : NaN,
    };
  });
}
// インパクトの目安
//  ストローク：ヘッドが一番速いコマ
//  サーブ・スマッシュ：一番速いコマの0.2秒前〜0.1秒後のうち、ヘッド（なければ手首）が一番高いコマ
//  ボレー：速さが最大の3割以上のコマのうち、肩から手までが一番伸びたコマ
function autoImpact(c) {
  const useRacket = c.m.some(m => Number.isFinite(m.speed));
  const key = useRacket ? 'speed' : 'wspeed';
  const vmax = Math.max(0, ...c.m.map(m => m[key]).filter(Number.isFinite));
  const R = c.side === 'R', wr = R ? L.rWr : L.lWr, sh = R ? L.rSh : L.lSh;
  const peak = c.m.findIndex(m => m[key] === vmax);
  const score = i => {
    const m = c.m[i], v = m[key];
    if (!Number.isFinite(v)) return -Infinity;
    if (c.shot === 'serve') {
      if (i < peak - 0.2 * c.fps || i > peak + 0.1 * c.fps) return -Infinity;
      const r = c.racket[i], p = useRacket ? (r && r.kind !== 'interp' ? r : null) : c.lm[i] && lmPx(c, c.lm[i], wr);
      return p ? -p.y : -Infinity;
    }
    if (c.shot === 'volley') {
      if (v < vmax * 0.3 || !c.lm[i]) return -Infinity;
      return dist(lmPx(c, c.lm[i], sh), handPx(c, c.lm[i], c.side));
    }
    return v;
  };
  let bi = -1, bv = -Infinity;
  c.m.forEach((_, i) => { const v = score(i); if (v > bv) { bv = v; bi = i; } });
  c.impact = bi >= 0 ? bi : Math.floor(c.frames.length / 2);
}
function recompute(c, findImpact) {
  computeRacket(c); computeMetrics(c);
  if (findImpact) autoImpact(c);
}

/* ---------------- 表示 ---------------- */
let mode = 'side', tRel = 0, playing = false, fixMode = false;
const opt = () => ({
  skel: $('#tSkel').checked, ang: $('#tAng').checked, racket: $('#tRacket').checked, trail: $('#tTrail').checked,
  wrist: $('#tWrist').checked, full: $('#tFull').checked, dim: $('#tDim').checked,
});
const idxAt = (c, t) => Math.max(0, Math.min(c.frames.length - 1, c.impact + Math.round(t * c.fps)));
function bounds() {
  const r = ready(); if (!r.length) return [0, 0];
  return [Math.min(...r.map(c => -c.impact / c.fps)), Math.max(...r.map(c => (c.frames.length - 1 - c.impact) / c.fps))];
}
const stepT = () => 1 / Math.max(...ready().map(c => c.fps), 30);

function updateViewer(justAnalyzed) {
  const r = ready();
  $('#viewer').classList.toggle('hidden', !r.length);
  if (!r.length) return;
  const both = r.length === 2;
  if (!both && mode === 'overlay') setMode('side');
  $('#modebar [data-mode=overlay]').disabled = !both;
  $('#lMirrorB').classList.toggle('hidden', !both);
  layout();
  if (justAnalyzed) tRel = 0;
  setupScrub();
  buildMetricSelect();
  renderAll();
  if (justAnalyzed) $('#viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function layout() {
  const r = ready(), A = clips.A.ready, B = clips.B.ready;
  const stage = $('#stage');
  if (mode === 'overlay') {
    $('#viewA').classList.remove('hidden'); $('#viewB').classList.add('hidden'); stage.classList.add('one');
    $('#viewA .lbl').textContent = 'A ＋ B';
  } else {
    $('#viewA').classList.toggle('hidden', !A); $('#viewB').classList.toggle('hidden', !B);
    stage.classList.toggle('one', r.length < 2);
    stage.classList.toggle('stack', r.length === 2 && r.every(c => c.W > c.H));   // 横長どうしはスマホで縦に並べる
    $('#viewA .lbl').textContent = 'A';
  }
}
function setMode(m) {
  mode = m;
  document.querySelectorAll('#modebar button').forEach(b => b.classList.toggle('sel', b.dataset.mode === m));
  layout(); renderAll();
}
document.querySelectorAll('#modebar button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

function setupScrub() {
  const [a, b] = bounds(), s = $('#scrub');
  s.min = a; s.max = b; s.step = stepT(); s.value = tRel;
}
function setT(t) {
  const [a, b] = bounds();
  tRel = Math.max(a, Math.min(b, t));
  $('#scrub').value = tRel;
  renderAll();
}

function sizeCanvas(cv, c) {
  const w = cv.parentElement.clientWidth || 400, dpr = Math.min(2, devicePixelRatio || 1);
  const W = Math.round(w * dpr), H = Math.round(w * dpr * c.H / c.W);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
}
function renderAll() {
  const r = ready(); if (!r.length) return;
  const o = opt();
  if (mode === 'overlay' && clips.A.ready && clips.B.ready) {
    renderOverlay(o);
  } else {
    for (const c of r) {
      const cv = $(`#view${c.id} canvas`);
      sizeCanvas(cv, c);
      drawClip(cv.getContext('2d'), cv, c, idxAt(c, tRel), o, c.id === 'B' && $('#tMirrorB').checked);
    }
  }
  const [a, b] = bounds();
  $('#time').innerHTML = `<b>${tRel >= 0 ? '+' : ''}${tRel.toFixed(2)}秒</b><br>${tRel === 0 ? 'インパクト' : (tRel < 0 ? 'インパクト前' : 'インパクト後')}`;
  drawGraph(); drawTable();
}

// 座標をキャンバスへ（左右反転にも対応）
const mapper = (cv, c, mirror) => p => ({ x: (mirror ? c.W - p.x : p.x) * cv.width / c.W, y: p.y * cv.height / c.H });

function drawClip(ctx, cv, c, i, o, mirror) {
  const f = c.frames[i], M = mapper(cv, c, mirror);
  ctx.save();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (mirror) { ctx.translate(cv.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(f.img, 0, 0, cv.width, cv.height);
  ctx.restore();
  if (o.dim) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, cv.width, cv.height); }
  const u = cv.width / 600;
  drawOverlay(ctx, c, i, o, M, u, COL.skel, true);
  // インパクトのしるし
  if (i === c.impact) {
    ctx.font = `800 ${14 * u + 6}px "M PLUS 1p",sans-serif`; ctx.fillStyle = COL.racket;
    ctx.textAlign = 'right'; ctx.fillText('インパクト', cv.width - 10, 10 + 16 * u + 6);
  }
}
function drawOverlay(ctx, c, i, o, M, u, color, withAngles) {
  const lm = c.lm[i];
  const lw = Math.max(1.5, 2.2 * u);
  // 軌跡
  const from = o.full ? 0 : Math.max(0, i - Math.round(c.fps * SHOTS[c.shot].trail));
  const to = o.full ? c.frames.length - 1 : i;
  if (o.wrist) trail(ctx, from, to, k => c.lm[k] && M(lmPx(c, c.lm[k], c.side === 'R' ? L.rWr : L.lWr)), color === COL.skel ? '#9fe8ff' : color, lw * 0.9, i, c.impact, false);
  if (o.trail && o.racket) trail(ctx, from, to, k => c.racket[k] && M(c.racket[k]), color === COL.skel ? COL.racket : color, lw * 1.4, i, c.impact, true);
  if (lm && o.skel) {
    const P = k => M(lmPx(c, lm, k));
    ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.globalAlpha = 0.92;
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 3 * u;
    ctx.beginPath();
    for (const [a, b] of BONES) { const p = P(a), q = P(b); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.stroke();
    // 首（肩の中点→鼻）
    const sm = mid(P(L.lSh), P(L.rSh)), ns = P(L.nose);
    ctx.beginPath(); ctx.moveTo(sm.x, sm.y); ctx.lineTo(ns.x, ns.y); ctx.stroke();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    for (const j of JOINTS) {
      const p = P(j);
      ctx.beginPath(); ctx.arc(p.x, p.y, (j === 0 ? 4 : 3.2) * u + 1, 0, 7);
      ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
    }
    if (withAngles && o.ang && c.m[i]) {
      const R = c.side === 'R', m = c.m[i];
      label(ctx, P(R ? L.rEl : L.lEl), Math.round(m.elbow) + '°', u);
      const kr = P(L.rKn), kl = P(L.lKn);
      label(ctx, kr, Math.round(m.kneeR) + '°', u, kr.x < kl.x);
      label(ctx, kl, Math.round(m.kneeL) + '°', u, kl.x <= kr.x);
    }
  }
  // ラケット（手→ヘッド）
  const r = c.racket[i];
  if (o.racket && r && lm) {
    const h = M(handPx(c, lm, c.side)), p = M(r);
    const rc = color === COL.skel ? COL.racket : color;
    ctx.strokeStyle = rc; ctx.lineWidth = lw; ctx.setLineDash(r.kind === 'interp' ? [5 * u, 4 * u] : []);
    ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath();
    if (r.kind === 'manual') ctx.rect(p.x - 7 * u, p.y - 7 * u, 14 * u, 14 * u);
    else ctx.arc(p.x, p.y, 8 * u, 0, 7);
    ctx.lineWidth = 2.5 * u; ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.5 * u, 0, 7); ctx.fillStyle = rc; ctx.fill();
  }
}
function trail(ctx, from, to, get, color, lw, cur, impact, markImpact) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  let prev = null;
  for (let k = from; k <= to; k++) {
    const p = get(k);
    if (p && prev) {
      const age = k > cur ? 0.25 : 0.25 + 0.75 * (1 - (cur - k) / Math.max(1, cur - from + 1));
      ctx.globalAlpha = Math.max(0.15, age); ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    prev = p;
  }
  ctx.globalAlpha = 1;
  if (markImpact && impact >= from && impact <= to) {
    const p = get(impact);
    if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, lw * 3, 0, 7); ctx.strokeStyle = '#fff'; ctx.lineWidth = lw * 0.8; ctx.stroke(); }
  }
}
function label(ctx, p, t, u, left) {
  ctx.font = `700 ${11 * u + 5}px "M PLUS 1p",sans-serif`;
  const w = ctx.measureText(t).width + 8, h = 11 * u + 9;
  const x = left ? p.x - 8 * u - w : p.x + 8 * u, y = p.y - h / 2;
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 4, y + h / 2);
  ctx.textBaseline = 'alphabetic';
}

// 重ねて比べる：Bの骨格をAの腰の位置・胴の長さに合わせる
function renderOverlay(o) {
  const A = clips.A, B = clips.B, cv = $('#viewA canvas'), ctx = cv.getContext('2d');
  sizeCanvas(cv, A);
  const ia = idxAt(A, tRel), ib = idxAt(B, tRel);
  drawClipBase(ctx, cv, A, ia, o);
  const MA = mapper(cv, A, false), u = cv.width / 600;
  const anchorOf = (c, i) => { const lm = c.lm[i] || nearestLm(c, i); return lm ? mid(lmPx(c, lm, L.lHip), lmPx(c, lm, L.rHip)) : null; };
  const aA = anchorOf(A, ia), aB = anchorOf(B, ib);
  if (aA && aB) {
    const s = A.torso / B.torso, mir = $('#tMirrorB').checked;
    const MB = p => MA({ x: aA.x + (mir ? -1 : 1) * (p.x - aB.x) * s, y: aA.y + (p.y - aB.y) * s });
    drawOverlay(ctx, B, ib, { ...o, ang: false }, MB, u, COL.B, false);
  }
  drawOverlay(ctx, A, ia, o, MA, u, COL.A, true);
}
function drawClipBase(ctx, cv, c, i, o) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(c.frames[i].img, 0, 0, cv.width, cv.height);
  ctx.fillStyle = `rgba(0,0,0,${o.dim ? .6 : .3})`; ctx.fillRect(0, 0, cv.width, cv.height);
}
function nearestLm(c, i) {
  for (let d = 1; d < 10; d++) { if (c.lm[i - d]) return c.lm[i - d]; if (c.lm[i + d]) return c.lm[i + d]; }
  return null;
}

/* ---------------- グラフ・表 ---------------- */
function buildMetricSelect() {
  const s = $('#metric'); if (s.options.length) return;
  METRICS.forEach(m => s.add(new Option(m.name, m.key)));
  s.onchange = drawGraph;
}
function drawGraph() {
  const cv = $('#graph'), r = ready(); if (!r.length) return;
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const key = $('#metric').value, M = METRICS.find(m => m.key === key);
  const [t0, t1] = bounds();
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  let lo = Infinity, hi = -Infinity;
  for (const c of r) for (const m of c.m) { const v = m?.[key]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  const legend = $('#legend'); legend.innerHTML = '';
  if (!Number.isFinite(lo)) { ctx.fillStyle = '#9db3a8'; ctx.font = '13px sans-serif'; ctx.fillText('この項目のデータがありません', pad.l, h / 2); return; }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
  const X = t => pad.l + (t - t0) / (t1 - t0 || 1) * (w - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  // 目盛り
  ctx.strokeStyle = '#2c443b'; ctx.fillStyle = '#9db3a8'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(v.toFixed(M.dec ?? 0), pad.l - 5, y + 4);
  }
  ctx.textAlign = 'center';
  const stp = (t1 - t0) > 2 ? 0.5 : 0.2;
  for (let t = Math.ceil(t0 / stp) * stp; t <= t1 + 1e-9; t += stp) ctx.fillText(t.toFixed(1), X(t), h - 6);
  // インパクトの線
  ctx.strokeStyle = '#ffe14d'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(0), pad.t); ctx.lineTo(X(0), h - pad.b); ctx.stroke(); ctx.setLineDash([]);
  for (const c of r) {
    ctx.strokeStyle = COL[c.id]; ctx.lineWidth = 2.2; ctx.beginPath();
    let pen = false;
    c.m.forEach((m, i) => {
      const v = m?.[key], t = (i - c.impact) / c.fps;
      if (!Number.isFinite(v)) { pen = false; return; }
      pen ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v)); pen = true;
    });
    ctx.stroke();
    legend.insertAdjacentHTML('beforeend', `<span style="--c:${COL[c.id]}">${c.id}</span>`);
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(tRel), pad.t); ctx.lineTo(X(tRel), h - pad.b); ctx.stroke();
  legend.insertAdjacentHTML('beforeend', `<span style="--c:#ffe14d">インパクト</span><span>単位：${M.unit}</span>`);
  cv._x2t = x => t0 + (x - pad.l) / (w - pad.l - pad.r) * (t1 - t0);
}
(() => {
  const cv = $('#graph'); let down = false;
  const go = e => { const r = cv.getBoundingClientRect(); cv._x2t && setT(snap(cv._x2t(e.clientX - r.left))); };
  cv.onpointerdown = e => { down = true; stop(); go(e); };
  cv.onpointermove = e => down && go(e);
  addEventListener('pointerup', () => down = false);
})();
const snap = t => Math.round(t / stepT()) * stepT();
function drawTable() {
  const r = ready(), tb = $('#table');
  const fmt = (c, k, d) => { const v = c.m[idxAt(c, tRel)]?.[k]; return Number.isFinite(v) ? v.toFixed(d ?? 0) : '–'; };
  tb.innerHTML = `<tr><th></th>${r.map(c => `<th class="${c.id}">${c.id}</th>`).join('')}</tr>` +
    METRICS.map(m => `<tr><td>${m.name}</td>${r.map(c => `<td>${fmt(c, m.key, m.dec)}${m.unit === '°' ? '°' : ''}</td>`).join('')}</tr>`).join('');
}

/* ---------------- 再生・操作 ---------------- */
let last = 0;
function loop(ts) {
  if (!playing) return;
  const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
  const [a, b] = bounds();
  tRel += dt * +$('#speed').value;
  if (tRel > b) tRel = a;           // 最後まで行ったら最初から
  $('#scrub').value = tRel;
  renderAll();
  requestAnimationFrame(loop);
}
function play() {
  if (!ready().length) return;
  playing = true; $('#play').textContent = '❚❚';
  const [, b] = bounds(); if (tRel >= b - 1e-6) tRel = bounds()[0];
  last = performance.now(); requestAnimationFrame(loop);
}
function stop() { if (playing) { playing = false; $('#play').textContent = '▶'; setT(snap(tRel)); } }
$('#play').onclick = () => playing ? stop() : play();
$('#prev').onclick = () => { stop(); setT(snap(tRel) - stepT()); };
$('#next').onclick = () => { stop(); setT(snap(tRel) + stepT()); };
$('#scrub').oninput = e => { stop(); setT(+e.target.value); };
$('#toImpact').onclick = () => { stop(); setT(0); };
$('#setImpact').onclick = () => {
  stop();
  for (const c of ready()) { c.impact = idxAt(c, tRel); saveMeta(c); }
  setupScrub(); setT(0);
};
$('#autoImpact').onclick = () => { stop(); ready().forEach(c => { autoImpact(c); saveMeta(c); }); setupScrub(); setT(0); };
['#tSkel', '#tAng', '#tRacket', '#tTrail', '#tWrist', '#tFull', '#tDim', '#tMirrorB'].forEach(s => $(s).onchange = renderAll);
addEventListener('resize', () => { if (ready().length) { layout(); renderAll(); } });
addEventListener('keydown', e => {
  if (!ready().length || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); $('#prev').click(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); $('#next').click(); }
});

// ヘッドの位置を直す
$('#fix').onclick = () => {
  fixMode = !fixMode; stop();
  $('#fix').classList.toggle('on', fixMode);
  $('#fixbar').classList.toggle('hidden', !fixMode);
  if (fixMode && mode === 'overlay') setMode('side');
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('fix', fixMode));
};
for (const id of ['A', 'B']) {
  $(`#view${id} canvas`).addEventListener('click', e => {
    if (!fixMode || mode === 'overlay') return;
    const c = clips[id]; if (!c.ready) return;
    const cv = e.currentTarget, r = cv.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (id === 'B' && $('#tMirrorB').checked) x = 1 - x;
    const i = idxAt(c, tRel);
    c.manual[i] = { x, y };
    recompute(c, false); summary(c); saveMeta(c);
    if ($('#fixAdvance').checked) { if (ready().length > 1) setT(snap(tRel) + stepT()); else setT(snap(tRel) + stepT()); }
    else renderAll();
  });
}
const fixTargets = () => ready();
$('#fixNone').onclick = () => { for (const c of fixTargets()) { c.manual[idxAt(c, tRel)] = 'none'; recompute(c, false); saveMeta(c); } renderAll(); };
$('#fixClear').onclick = () => { for (const c of fixTargets()) { delete c.manual[idxAt(c, tRel)]; recompute(c, false); saveMeta(c); } renderAll(); };

// 画像で保存
$('#snap').onclick = () => {
  const views = [...document.querySelectorAll('.view:not(.hidden) canvas')];
  const gap = 12, hh = Math.max(...views.map(v => v.height));
  const out = document.createElement('canvas');
  out.width = views.reduce((s, v) => s + v.width * hh / v.height, 0) + gap * (views.length - 1);
  out.height = hh + 40;
  const x = out.getContext('2d');
  x.fillStyle = '#0f1a17'; x.fillRect(0, 0, out.width, out.height);
  let px = 0;
  views.forEach(v => { const w = v.width * hh / v.height; x.drawImage(v, px, 0, w, hh); px += w + gap; });
  x.fillStyle = '#e9f1ec'; x.font = '700 20px "M PLUS 1p",sans-serif';
  x.fillText(`インパクト${tRel >= 0 ? '+' : ''}${tRel.toFixed(2)}秒`, 12, hh + 28);
  out.toBlob(b => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = `フォーム_${tRel >= 0 ? '+' : ''}${tRel.toFixed(2)}s.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
};
window.fc = { clips };
