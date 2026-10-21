'use strict';
/* MM Studio – trình xem .mm (OKMindmap/Freemind) chạy hoàn toàn trên trình duyệt. */
const $ = s => document.querySelector(s);
const MAX_BYTES = 20 * 1024 * 1024, GX = 64, GY = 14;
const ALLOWED = new Set('p br b i u s strong em code pre span div ul ol li h1 h2 h3 h4 h5 h6 a img sub sup blockquote table thead tbody tr td th'.split(' '));
const DROP = /^(script|style|iframe|object|embed|head|link|meta|form|input|button|svg|math)$/;
const BAD_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/i;
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const color = c => (c && /^#[0-9a-f]{3,8}$/i.test(c.trim())) ? c.trim() : null;
function safeUrl(u) {
  try { const x = new URL(u); return (/^https?:$/.test(x.protocol) && !BAD_HOST.test(x.hostname)) ? x.href : null; } catch { return null; }
}

/* ---------- 1. BỘ ĐỌC .MM ---------- */
// Làm sạch HTML từ XML bằng danh sách cho phép (không dùng innerHTML, bỏ style/script/on*).
function clean(src, dst, rep) {
  for (const n of src.childNodes) {
    if (n.nodeType === 3) { dst.append(n.nodeValue); continue; }
    if (n.nodeType !== 1) continue;
    const t = n.localName.toLowerCase();
    if (!ALLOWED.has(t)) { if (DROP.test(t)) rep.dropped[t] = (rep.dropped[t] || 0) + 1; else clean(n, dst, rep); continue; }
    const e = document.createElement(t);
    if (t === 'a') { const h = n.getAttribute('href') || ''; if (/^(https?:|mailto:)/i.test(h)) { e.href = h; e.target = '_blank'; e.rel = 'noopener noreferrer'; } }
    if (t === 'img') {
      const s = n.getAttribute('src') || '';
      if (!/^(https?:|data:image\/)/i.test(s)) continue;
      e.src = s; e.loading = 'lazy'; e.referrerPolicy = 'no-referrer'; e.alt = '';
      for (const k of ['width', 'height']) if (/^\d+$/.test(n.getAttribute(k) || '')) e.setAttribute(k, n.getAttribute(k));
    }
    clean(n, e, rep); dst.append(e);
  }
}
function parseNode(el, rep, depth, side) {
  const g = a => el.getAttribute(a);
  const n = { id: g('ID') || 'n' + rep.nodes, depth, children: [], bg: color(g('BACKGROUND_COLOR')), color: color(g('COLOR')),
    size: null, edge: null, ew: 2, folded: g('FOLDED') === 'true', embed: null, note: null, attrs: {}, extra: [], parent: null };
  n.side = depth === 0 ? 0 : depth === 1 ? (g('POSITION') === 'left' ? -1 : 1) : side;
  rep.nodes++; rep.depth = Math.max(rep.depth, depth + 1);
  const known = ['ID', 'TEXT', 'BACKGROUND_COLOR', 'COLOR', 'FOLDED', 'LINK', 'POSITION'];
  for (const a of el.attributes) if (!known.includes(a.name)) n.attrs[a.name] = a.value; // giữ lại thuộc tính chưa dùng
  const body = document.createElement('div'); body.className = 'body';
  if (g('TEXT')) { const p = document.createElement('p'); p.textContent = g('TEXT'); body.append(p); }
  for (const c of el.children) {
    const t = c.localName;
    if (t === 'node') { const k = parseNode(c, rep, depth + 1, n.side); k.parent = n; n.children.push(k); }
    else if (t === 'edge') { n.edge = color(c.getAttribute('COLOR')); n.ew = +c.getAttribute('WIDTH') || 2; }
    else if (t === 'font') n.size = +c.getAttribute('SIZE') || null;
    else if (t === 'richcontent') {
      const b = c.getElementsByTagName('body')[0];
      if (c.getAttribute('TYPE') === 'NODE') { if (b) clean(b, body, rep); }
      else { n.note = document.createElement('div'); if (b) clean(b, n.note, rep); }
    } else if (t === 'foreignObject') {
      const f = c.firstElementChild;
      if (f && f.localName.toLowerCase() === 'iframe') {
        const s = safeUrl(f.getAttribute('src') || '');
        if (s) n.embed = { kind: 'iframe', src: s }; else rep.blocked++;
      } else clean(c, body, rep); // khối HTML nhúng: hiển thị đã làm sạch, không chạy mã
    } else if (t === 'attribute') n.attrs['@' + c.getAttribute('NAME')] = c.getAttribute('VALUE');
    else { rep.unknown[t] = (rep.unknown[t] || 0) + 1; n.extra.push(new XMLSerializer().serializeToString(c)); }
  }
  const link = safeUrl(g('LINK') || '');
  if (!n.embed && link) n.embed = { kind: 'link', src: link };
  if (n.embed) rep.embeds++;
  n.body = body;
  n.title = (body.textContent.trim().split('\n')[0] || '').slice(0, 80) || (n.embed ? new URL(n.embed.src).hostname : '(trống)');
  n.search = norm(body.textContent + ' ' + (n.note ? n.note.textContent : '') + ' ' + (n.embed ? n.embed.src : ''));
  return n;
}
function parseMM(text) {
  if (/<!ENTITY/i.test(text)) throw new Error('Tệp chứa khai báo ENTITY nên bị từ chối vì lý do bảo mật (XXE).');
  const doc = new DOMParser().parseFromString(text, 'application/xml'); // không tải tài nguyên ngoài
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Tệp không phải XML hợp lệ hoặc bị hỏng.');
  const root = doc.documentElement;
  if (root.localName !== 'map') throw new Error('Không phải tệp .mm: phần tử gốc phải là <map>.');
  const first = [...root.children].find(c => c.localName === 'node');
  if (!first) throw new Error('Sơ đồ không có nút nào.');
  const rep = { nodes: 0, depth: 0, embeds: 0, blocked: 0, unknown: {}, dropped: {} };
  return { version: root.getAttribute('version'), root: parseNode(first, rep, 0, 0), rep };
}

/* ---------- 2. HIỂN THỊ ---------- */
let M = null, ALL = [], R = null, curName = '', curText = '', curSrcFile = null, sel = null, hits = [], hi = -1;
const V = { x: 0, y: 0, k: 1 }, vp = $('#viewport'), stage = $('#stage');

function buildDom() {
  $('#nodes').replaceChildren(); ALL = [];
  (function walk(n) {
    ALL.push(n);
    const el = document.createElement('div');
    el.className = 'node d' + Math.min(n.depth, 3) + (n.side < 0 ? ' sl' : ' sr'); el.dataset.id = n.id;
    if (n.bg) el.style.background = n.bg;
    if (n.color) el.style.color = n.color;
    if (n.size) el.style.fontSize = n.size + 'px';
    el.append(n.body);
    if (n.embed) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = '▶ ' + (n.embed.kind === 'iframe' ? 'Nội dung nhúng · ' : 'Liên kết · ') + new URL(n.embed.src).hostname; el.append(c); }
    if (n.children.length && n.depth > 0) { const b = document.createElement('button'); b.className = 'tg'; b.dataset.tg = '1'; b.title = 'Thu gọn/mở rộng nhánh'; el.append(b); n.tg = b; }
    n.el = el; $('#nodes').append(el); n.children.forEach(walk);
  })(R);
}
const vis = n => n.folded ? [] : n.children;
function sh(n, kids) { const k = kids || vis(n); n.sh = k.length ? Math.max(n.h, k.reduce((a, c) => a + sh(c), 0) + GY * (k.length - 1)) : n.h; return n.sh; }
function placeKids(n, kids, dir) {
  if (!kids.length) return;
  const total = kids.reduce((a, c) => a + sh(c), 0) + GY * (kids.length - 1);
  let top = n.y + n.h / 2 - total / 2;
  for (const c of kids) {
    c.x = dir > 0 ? n.x + n.w + GX : n.x - GX - c.w; c.y = top + c.sh / 2 - c.h / 2; top += c.sh + GY;
    placeKids(c, vis(c), dir);
  }
}
function layout() {
  const shown = []; (function s(n) { shown.push(n); vis(n).forEach(s); })(R);
  ALL.forEach(n => n.el.style.display = 'none'); shown.forEach(n => n.el.style.display = '');
  shown.forEach(n => { n.w = n.el.offsetWidth; n.h = n.el.offsetHeight; if (n.tg) n.tg.textContent = n.folded ? n.children.length : '−'; });
  R.x = -R.w / 2; R.y = -R.h / 2;
  placeKids(R, R.children.filter(c => c.side >= 0), 1); placeKids(R, R.children.filter(c => c.side < 0), -1);
  let d = '', b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
  for (const n of shown) {
    n.el.style.transform = `translate(${n.x}px,${n.y}px)`;
    b.x0 = Math.min(b.x0, n.x); b.x1 = Math.max(b.x1, n.x + n.w); b.y0 = Math.min(b.y0, n.y); b.y1 = Math.max(b.y1, n.y + n.h);
    if (!n.parent) continue;
    const p = n.parent, dir = n.side, ax = dir > 0 ? p.x + p.w : p.x, ay = p.y + p.h / 2, bx = dir > 0 ? n.x : n.x + n.w, by = n.y + n.h / 2, mx = (ax + bx) / 2;
    d += `<path d="M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}" stroke="${n.edge || '#8a94b0'}" stroke-width="${n.ew}"/>`;
  }
  $('#edges').innerHTML = d; M.bounds = b;
  $('#status').textContent = status();
}
function status() {
  const r = M.rep, u = Object.keys(r.unknown), dr = Object.keys(r.dropped);
  return `${r.nodes} nút · ${r.depth} cấp · ${r.embeds} nội dung nhúng/liên kết` + (r.blocked ? ` · ${r.blocked} URL bị chặn (không an toàn)` : '') +
    (u.length ? ` · thẻ chưa hỗ trợ (đã giữ nguyên dữ liệu): ${u.join(', ')}` : '') + (dr.length ? ` · đã loại thẻ nguy hiểm: ${dr.join(', ')}` : '');
}
function apply() { stage.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.k})`; $('#zoomv').textContent = Math.round(V.k * 100) + '%'; }
function anim() { stage.classList.add('anim'); setTimeout(() => stage.classList.remove('anim'), 320); }
function zoomAt(f, cx, cy, an) { const k = clamp(V.k * f, .08, 3), r = k / V.k; V.x = cx - (cx - V.x) * r; V.y = cy - (cy - V.y) * r; V.k = k; if (an) anim(); apply(); }
function fit() {
  const r = vp.getBoundingClientRect(), b = M.bounds, bw = b.x1 - b.x0 + 80, bh = b.y1 - b.y0 + 80;
  V.k = clamp(Math.min(r.width / bw, r.height / bh), .08, 1.2);
  V.x = r.width / 2 - (b.x0 + b.x1) / 2 * V.k; V.y = r.height / 2 - (b.y0 + b.y1) / 2 * V.k; anim(); apply();
}
function centerOn(n) {
  const r = vp.getBoundingClientRect(); V.k = Math.max(V.k, .7);
  V.x = r.width / 2 - (n.x + n.w / 2) * V.k; V.y = r.height / 2 - (n.y + n.h / 2) * V.k; anim(); apply();
}
function setFold(n, f) { if (n.children.length && n.depth > 0) n.folded = f; }

/* ---------- 3. TƯƠNG TÁC ---------- */
let moved = false; const ptr = new Map(); let pinch = 0;
vp.addEventListener('wheel', e => { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
vp.addEventListener('pointerdown', e => { ptr.set(e.pointerId, e); moved = false; if (ptr.size === 2) { const [a, b] = [...ptr.values()]; pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); } });
vp.addEventListener('pointermove', e => {
  if (!ptr.has(e.pointerId)) return;
  const prev = ptr.get(e.pointerId); ptr.set(e.pointerId, e);
  if (ptr.size === 2) {
    const [a, b] = [...ptr.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), r = vp.getBoundingClientRect();
    if (pinch) zoomAt(d / pinch, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top); pinch = d; moved = true; return;
  }
  const dx = e.clientX - prev.clientX, dy = e.clientY - prev.clientY;
  if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
  if (!moved) vp.setPointerCapture(e.pointerId);
  moved = true; vp.classList.add('drag'); V.x += dx; V.y += dy; apply();
});
const up = e => { ptr.delete(e.pointerId); pinch = 0; vp.classList.remove('drag'); };
vp.addEventListener('pointerup', up); vp.addEventListener('pointercancel', up);
vp.addEventListener('click', e => {
  if (moved) return;
  const el = e.target.closest('.node'); if (!el) return;
  const n = ALL.find(x => x.id === el.dataset.id); if (!n) return;
  if (e.target.closest('a')) return;
  if (e.target.dataset.tg) { setFold(n, !n.folded); layout(); return; }
  select(n);
});
function select(n) {
  if (sel) sel.el.classList.remove('sel'); sel = n; n.el.classList.add('sel');
  if (n.embed || !$('#panel').hidden) { const was = $('#panel').hidden; showPanel(n); if (was) setTimeout(() => centerOn(n), 0); }
}
function showPanel(n) {
  $('#panel').hidden = false; $('#pTitle').textContent = n.title;
  const c = $('#pBody'); c.replaceChildren();
  const pb = document.createElement('div'); pb.className = 'pb'; pb.append(n.body.cloneNode(true));
  if (n.note) pb.append(n.note.cloneNode(true));
  if (pb.textContent.trim() || pb.querySelector('img')) c.append(pb);
  const o = $('#pOpen'); o.hidden = !n.embed; $('#pHint').hidden = !(n.embed && n.embed.kind === 'iframe');
  if (n.embed) {
    o.href = n.embed.src;
    if (n.embed.kind === 'iframe') {
      const f = document.createElement('iframe'); f.title = n.title;
      let sb = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals';
      if (new URL(n.embed.src).origin !== location.origin) sb += ' allow-same-origin'; // chỉ cấp cho nguồn khác origin
      f.setAttribute('sandbox', sb); f.allow = 'fullscreen; autoplay; clipboard-write; encrypted-media'; f.loading = 'lazy'; f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.src = n.embed.src; c.append(f);
    } else { const p = document.createElement('p'); p.textContent = 'Nút này là liên kết ngoài. Dùng “Mở tab mới” để xem.'; c.append(p); }
  }
}
function closePanel() { $('#panel').hidden = true; $('#pBody').replaceChildren(); setTimeout(fit, 0); }

/* Tìm kiếm không phân biệt dấu/hoa thường */
function search() {
  const q = norm($('#q').value.trim());
  hits.forEach(n => n.el.classList.remove('hit', 'cur')); hits = []; hi = -1;
  if (q) hits = ALL.filter(n => n.search.includes(q));
  hits.forEach(n => { for (let p = n.parent; p; p = p.parent) p.folded = false; });
  layout(); hits.forEach(n => n.el.classList.add('hit'));
  $('#qc').textContent = q ? (hits.length ? '' : 'Không có kết quả') : ''; if (hits.length) goHit(1);
}
function goHit(d) {
  if (!hits.length) return;
  if (hi >= 0) hits[hi].el.classList.remove('cur');
  hi = (hi + d + hits.length) % hits.length; hits[hi].el.classList.add('cur'); centerOn(hits[hi]);
  $('#qc').textContent = `${hi + 1}/${hits.length}`;
}

/* ---------- 4. TẢI, CHIA SẺ, MÀN HÌNH CHÍNH ---------- */
function openMap(text, name, opts = {}) {
  M = parseMM(text); R = M.root; curName = name; curText = text; curSrcFile = opts.file || null; sel = null; hits = [];
  $('#q').value = ''; $('#qc').textContent = ''; $('#panel').hidden = true;
  buildDom(); $('#title').textContent = name; document.title = name + ' – MM Studio';
  $('#home').hidden = true; $('#work').hidden = false; layout(); fit();
  if (!opts.noRecent) saveRecent(name, text);
}
function showErr(m) { $('#err').textContent = m; }
async function loadFile(f) {
  showErr('');
  try {
    if (!f) return; if (f.size > MAX_BYTES) throw new Error('Tệp quá lớn (giới hạn 20 MB).');
    openMap(await f.text(), f.name.replace(/\.(mm|xml)$/i, ''));
  } catch (e) { showErr(e.message); goHome(); }
}
function saveRecent(name, text) {
  try {
    const l = JSON.parse(localStorage.getItem('mmstudio.recent') || '[]').filter(x => x.name !== name);
    if (text.length < 700000) l.unshift({ name, text, t: Date.now() });
    localStorage.setItem('mmstudio.recent', JSON.stringify(l.slice(0, 5)));
  } catch { /* localStorage đầy/bị chặn: bỏ qua */ }
}
function listRecent() {
  const ul = $('#recent'); ul.replaceChildren();
  let l = []; try { l = JSON.parse(localStorage.getItem('mmstudio.recent') || '[]'); } catch { }
  if (!l.length) ul.innerHTML = '<li class="muted">Chưa có.</li>';
  l.forEach(x => { const li = document.createElement('li'), b = document.createElement('button'); b.textContent = x.name; b.onclick = () => { try { openMap(x.text, x.name, { noRecent: true }); } catch (e) { showErr(e.message); } }; li.append(b, ' ', Object.assign(document.createElement('span'), { className: 'muted', textContent: new Date(x.t).toLocaleDateString('vi-VN') })); ul.append(li); });
}
async function listShared() {
  const ul = $('#shared');
  try {
    const r = await fetch('maps/index.json', { cache: 'no-cache' }); if (!r.ok) throw 0;
    const l = await r.json(); ul.replaceChildren();
    if (!l.length) ul.innerHTML = '<li class="muted">Chưa có sơ đồ nào.</li>';
    l.forEach(x => { if (!/^[\w.\-]+\.mm$/.test(x.file)) return; const li = document.createElement('li'), a = document.createElement('a'); a.href = '?map=' + encodeURIComponent(x.file); a.textContent = x.title || x.file; li.append(a); ul.append(li); });
  } catch { ul.innerHTML = '<li class="muted">Không tải được maps/index.json (cần chạy qua Live Server/hosting, không mở trực tiếp bằng file://).</li>'; }
}
async function loadShared(file) {
  try {
    if (!/^[\w.\-]+\.mm$/.test(file)) throw new Error('Tên sơ đồ không hợp lệ.');
    const r = await fetch('maps/' + file); if (!r.ok) throw new Error('Không tìm thấy sơ đồ “' + file + '” (đã bị gỡ hoặc sai liên kết).');
    openMap(await r.text(), file.replace(/\.mm$/, ''), { noRecent: true, file });
  } catch (e) { showErr(e.message); goHome(true); }
}
function goHome(keep) { if (!keep) history.replaceState(null, '', location.pathname); $('#work').hidden = true; $('#home').hidden = false; document.title = 'MM Studio'; listRecent(); }
function dialog(html) { $('#dlgBody').innerHTML = html; $('#dlg').showModal(); }
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function share() {
  const slug = (curSrcFile || (curName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'so-do') + '.mm');
  const url = new URL(location.href); url.search = '?map=' + encodeURIComponent(slug); url.hash = '';
  dialog(`<h3>Chia sẻ cho học sinh</h3>
   <p>Bản chạy tĩnh không có máy chủ lưu trữ, nên để chia sẻ: (1) đặt tệp <code>${esc(slug)}</code> vào thư mục <code>maps/</code>, (2) thêm dòng vào <code>maps/index.json</code>, (3) triển khai thư mục lên hosting tĩnh (GitHub Pages, Netlify, Cloudflare Pages…). Liên kết dạng:</p>
   <input readonly id="shareUrl" value="${esc(url.href)}"><p><button id="cpy">Sao chép liên kết</button> <button id="dlmm">Tải tệp .mm (${esc(slug)})</button></p>
   <p class="muted">Dòng cho index.json: <code>{"title":"${esc(curName.replace(/"/g, ''))}","file":"${esc(slug)}"}</code><br>Ai có liên kết đều xem được (chỉ đọc); đây không phải cơ chế bảo mật tuyệt đối.</p>`);
  $('#cpy').onclick = async () => { try { await navigator.clipboard.writeText(url.href); } catch { $('#shareUrl').select(); document.execCommand('copy'); } $('#cpy').textContent = 'Đã sao chép ✓'; };
  $('#dlmm').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([curText], { type: 'text/xml' })); a.download = slug; a.click(); };
}
function info() {
  const r = M.rep, e = ALL.filter(n => n.embed), hosts = {}; e.forEach(n => { const h = new URL(n.embed.src).hostname; hosts[h] = (hosts[h] || 0) + 1; });
  dialog(`<h3>${esc(curName)}</h3><p>${esc(status())}</p><p>Định dạng <code>map version ${esc(M.version || '?')}</code>.</p>
   <p><b>Nguồn nhúng:</b> ${Object.entries(hosts).map(([h, c]) => esc(h) + ' ×' + c).join(', ') || 'không có'}</p>
   <p class="muted">Một số trang (Facebook, Padlet, Wordwall…) có thể từ chối hiển thị trong khung nhúng tùy chính sách của họ; khi đó dùng “Mở tab mới”.</p>`);
}

/* ---------- 5. GẮN SỰ KIỆN ---------- */
const drop = $('#drop');
$('#pick').onclick = () => $('#file').click(); $('#file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
$('#bHome').onclick = () => goHome(); $('#bShare').onclick = share; $('#bInfo').onclick = info;
$('#bFit').onclick = fit; $('#bIn').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2, 1); };
$('#bOut').onclick = () => { const r = vp.getBoundingClientRect(); zoomAt(.8, r.width / 2, r.height / 2, 1); };
$('#bCollapse').onclick = () => { ALL.forEach(n => setFold(n, true)); layout(); fit(); };
$('#bExpand').onclick = () => { ALL.forEach(n => setFold(n, false)); layout(); fit(); };
$('#bPanel').onclick = () => { if ($('#panel').hidden) showPanel(sel || R); else closePanel(); setTimeout(fit, 0); };
$('#pClose').onclick = closePanel; $('#pFull').onclick = () => $('#pBody').requestFullscreen && ($('#pBody').querySelector('iframe') || $('#pBody')).requestFullscreen();
const full = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
$('#bFull').onclick = full; document.addEventListener('fullscreenchange', () => $('#work').hidden || setTimeout(fit, 150));
let qt; $('#q').oninput = () => { clearTimeout(qt); qt = setTimeout(search, 180); };
$('#q').onkeydown = e => { if (e.key === 'Enter') goHit(e.shiftKey ? -1 : 1); if (e.key === 'Escape') e.target.blur(); };
$('#qNext').onclick = () => goHit(1); $('#qPrev').onclick = () => goHit(-1);
addEventListener('resize', () => M && !$('#work').hidden && fit());
document.addEventListener('keydown', e => {
  if ($('#work').hidden || e.target.matches('input') || $('#dlg').open) return;
  const k = e.key, r = vp.getBoundingClientRect();
  if (k === '/' || ((e.ctrlKey || e.metaKey) && k === 'f')) { e.preventDefault(); $('#q').focus(); }
  else if (k === '+' || k === '=') zoomAt(1.25, r.width / 2, r.height / 2, 1);
  else if (k === '-') zoomAt(.8, r.width / 2, r.height / 2, 1);
  else if (k === '0') fit(); else if (k.toLowerCase() === 'f') full(); else if (k === 'Escape') closePanel();
});
listRecent(); listShared();
const qm = new URLSearchParams(location.search).get('map'); if (qm) loadShared(qm);
