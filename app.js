'use strict';
/* MM Studio – trình xem .mm (OKMindmap/Freemind) đã nâng cấp Hiệu suất & Bảo mật. */
const $ = s => document.querySelector(s);
const MAX_BYTES = 20 * 1024 * 1024, GX = 64, GY = 14;
const BAD_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/i;
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const color = c => (c && /^#[0-9a-f]{3,8}$/i.test(c.trim())) ? c.trim() : null;
function safeUrl(u) {
  try { const x = new URL(u); return (/^https?:$/.test(x.protocol) && !BAD_HOST.test(x.hostname)) ? x.href : null; } catch { return null; }
}

/* ---------- 1. BẢO MẬT & BỘ ĐỌC .MM ---------- */
// Thay thế hàm clean() cũ bằng DOMPurify để chống XSS an toàn tuyệt đối
function sanitizeRichHTML(rawHtml, rep) {
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'u', 's', 'strong', 'em', 'code', 'pre', 'span', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'sub', 'sup', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'td', 'th'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'width', 'height', 'target', 'rel'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'math', 'svg'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc'],
    RETURN_DOM_FRAGMENT: true
  });
  
  // Tự động ép tất cả thẻ <a> thành link an toàn
  cleanHtml.querySelectorAll('a').forEach(a => {
    const h = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(h)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href'); // Xóa href nếu protocol nguy hiểm (vd javascript:)
    }
  });

  return cleanHtml;
}

function parseNode(el, rep, depth, side) {
  const g = a => el.getAttribute(a);
  const n = { id: g('ID') || 'n' + rep.nodes, depth, children: [], bg: color(g('BACKGROUND_COLOR')), color: color(g('COLOR')),
    size: null, edge: null, ew: 2, folded: g('FOLDED') === 'true', embed: null, note: null, attrs: {}, extra: [], parent: null };
  n.side = depth === 0 ? 0 : depth === 1 ? (g('POSITION') === 'left' ? -1 : 1) : side;
  rep.nodes++; rep.depth = Math.max(rep.depth, depth + 1);
  const known = ['ID', 'TEXT', 'BACKGROUND_COLOR', 'COLOR', 'FOLDED', 'LINK', 'POSITION'];
  for (const a of el.attributes) if (!known.includes(a.name)) n.attrs[a.name] = a.value;

  const serializer = new XMLSerializer();
  let rawBodyHTML = '';
  let rawNoteHTML = '';

  if (g('TEXT')) rawBodyHTML += `<p>${g('TEXT').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;

  for (const c of el.children) {
    const t = c.localName;
    if (t === 'node') { const k = parseNode(c, rep, depth + 1, n.side); k.parent = n; n.children.push(k); }
    else if (t === 'edge') { n.edge = color(c.getAttribute('COLOR')); n.ew = +c.getAttribute('WIDTH') || 2; }
    else if (t === 'font') n.size = +c.getAttribute('SIZE') || null;
    else if (t === 'richcontent') {
      const b = c.getElementsByTagName('body')[0];
      if (b) {
        if (c.getAttribute('TYPE') === 'NODE') rawBodyHTML += serializer.serializeToString(b);
        else rawNoteHTML += serializer.serializeToString(b);
      }
    } else if (t === 'foreignObject') {
      const f = c.firstElementChild;
      if (f && f.localName.toLowerCase() === 'iframe') {
        const s = safeUrl(f.getAttribute('src') || '');
        if (s) n.embed = { kind: 'iframe', src: s }; else rep.blocked++;
      } else rawBodyHTML += serializer.serializeToString(c);
    } else if (t === 'attribute') n.attrs['@' + c.getAttribute('NAME')] = c.getAttribute('VALUE');
    else { rep.unknown[t] = (rep.unknown[t] || 0) + 1; n.extra.push(serializer.serializeToString(c)); }
  }

  const link = safeUrl(g('LINK') || '');
  if (!n.embed && link) n.embed = { kind: 'link', src: link };
  if (n.embed) rep.embeds++;

  // Lưu trữ HTML đã làm sạch
  n.cleanBody = sanitizeRichHTML(rawBodyHTML, rep);
  n.cleanNote = rawNoteHTML ? sanitizeRichHTML(rawNoteHTML, rep) : null;
  
  n.title = (n.cleanBody.textContent.trim().split('\n')[0] || '').slice(0, 80) || (n.embed ? new URL(n.embed.src).hostname : '(trống)');
  n.search = norm(n.cleanBody.textContent + ' ' + (n.cleanNote ? n.cleanNote.textContent : '') + ' ' + (n.embed ? n.embed.src : ''));
  
  // Reset size cache
  n.el = null; n.w = 0; n.h = 0;
  return n;
}

function parseMM(text) {
  if (/<!ENTITY/i.test(text)) throw new Error('Tệp chứa khai báo ENTITY nên bị từ chối vì lý do bảo mật (XXE).');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Tệp không phải XML hợp lệ hoặc bị hỏng.');
  const root = doc.documentElement;
  if (root.localName !== 'map') throw new Error('Không phải tệp .mm: phần tử gốc phải là <map>.');
  const first = [...root.children].find(c => c.localName === 'node');
  if (!first) throw new Error('Sơ đồ không có nút nào.');
  const rep = { nodes: 0, depth: 0, embeds: 0, blocked: 0, unknown: {}, dropped: {} };
  return { version: root.getAttribute('version'), root: parseNode(first, rep, 0, 0), rep };
}

/* ---------- 2. HIỂN THỊ & VIRTUALIZATION ---------- */
let M = null, ALL = [], R = null, curName = '', curText = '', curSrcFile = null, sel = null, hits = [], hi = -1;
const V = { x: 0, y: 0, k: 1 }, vp = $('#viewport'), stage = $('#stage');
const nodesContainer = $('#nodes');

// Hàm tạo phần tử DOM (Chỉ gọi khi node chưa có DOM, hỗ trợ Lazy)
function createDOM(n) {
  const el = document.createElement('div');
  el.className = 'node d' + Math.min(n.depth, 3) + (n.side < 0 ? ' sl' : ' sr'); el.dataset.id = n.id;
  if (n.bg) el.style.background = n.bg;
  if (n.color) el.style.color = n.color;
  if (n.size) el.style.fontSize = n.size + 'px';
  
  const bodyWrap = document.createElement('div'); bodyWrap.className = 'body';
  bodyWrap.appendChild(n.cleanBody.cloneNode(true));
  el.append(bodyWrap);

  if (n.embed) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = '▶ ' + (n.embed.kind === 'iframe' ? 'Nội dung nhúng · ' : 'Liên kết · ') + new URL(n.embed.src).hostname; el.append(c); }
  if (n.children.length && n.depth > 0) { const b = document.createElement('button'); b.className = 'tg'; b.dataset.tg = '1'; b.title = 'Thu gọn/mở rộng nhánh'; el.append(b); n.tg = b; }
  n.el = el;
  return el;
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

// Bóc tách quá trình Tính toán tọa độ
function layout() {
  const shown = []; 
  (function s(n) { shown.push(n); vis(n).forEach(s); })(R);
  
  // Tính kích thước các Node đang hiển thị (chỉ lấy số đo, chưa render)
  // Để đo w, h: chèn tạm vào DOM ẩn nếu chưa có
  const unmeasured = shown.filter(n => !n.el || !n.w || !n.h);
  if (unmeasured.length) {
    unmeasured.forEach(n => {
      if (!n.el) createDOM(n);
      n.el.style.visibility = 'hidden';
      nodesContainer.appendChild(n.el);
    });
    // Tránh layout thrashing: ghi DOM 1 loạt, đọc 1 loạt
    unmeasured.forEach(n => { n.w = n.el.offsetWidth; n.h = n.el.offsetHeight; });
    unmeasured.forEach(n => { n.el.style.visibility = ''; nodesContainer.removeChild(n.el); });
  }

  shown.forEach(n => { if (n.tg) n.tg.textContent = n.folded ? n.children.length : '−'; });
  R.x = -R.w / 2; R.y = -R.h / 2;
  placeKids(R, R.children.filter(c => c.side >= 0), 1); 
  placeKids(R, R.children.filter(c => c.side < 0), -1);
  
  let b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
  for (const n of shown) {
    b.x0 = Math.min(b.x0, n.x); b.x1 = Math.max(b.x1, n.x + n.w); b.y0 = Math.min(b.y0, n.y); b.y1 = Math.max(b.y1, n.y + n.h);
  }
  M.bounds = b;
  $('#status').textContent = status();
  renderView(); // Gọi windowing render
}

// Viewport Windowing: Chỉ gắn DOM cho các Node nằm trong màn hình
let renderRaf = 0;
function renderView() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    const r = vp.getBoundingClientRect();
    const vw = r.width / V.k, vh = r.height / V.k;
    const vx = -V.x / V.k, vy = -V.y / V.k;
    const pad = 300; // Vùng đệm để pan không bị giật trắng
    const vRect = { x0: vx - pad, x1: vx + vw + pad, y0: vy - pad, y1: vy + vh + pad };

    let dEdges = '';
    const inViewNodes = new Set();
    
    (function s(n) {
      // Intersection check
      const isInView = (n.x < vRect.x1 && n.x + n.w > vRect.x0 && n.y < vRect.y1 && n.y + n.h > vRect.y0);
      if (isInView) inViewNodes.add(n);
      
      const kids = vis(n);
      // Vẽ đường nối nếu cha hoặc con nằm trong viewport
      for(const c of kids) {
         const cInView = (c.x < vRect.x1 && c.x + c.w > vRect.x0 && c.y < vRect.y1 && c.y + c.h > vRect.y0);
         if (isInView || cInView) {
            const dir = c.side, ax = dir > 0 ? n.x + n.w : n.x, ay = n.y + n.h / 2, bx = dir > 0 ? c.x : c.x + c.w, by = c.y + c.h / 2, mx = (ax + bx) / 2;
            dEdges += `<path d="M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}" stroke="${c.edge || '#8a94b0'}" stroke-width="${c.ew}"/>`;
         }
         s(c);
      }
    })(R);

    // DOM Diffing hiệu suất cao
    for (const n of inViewNodes) {
      if (!n.el) createDOM(n);
      n.el.style.transform = `translate(${n.x}px,${n.y}px)`;
      if (n.el.parentNode !== nodesContainer) nodesContainer.appendChild(n.el);
    }
    
    // Gỡ các node trượt khỏi màn hình
    const currentDOMs = Array.from(nodesContainer.children);
    for (const el of currentDOMs) {
      const n = ALL.find(x => x.id === el.dataset.id);
      if (n && !inViewNodes.has(n)) nodesContainer.removeChild(el);
    }

    $('#edges').innerHTML = dEdges;
  });
}

function status() {
  const r = M.rep, u = Object.keys(r.unknown), dr = Object.keys(r.dropped);
  return `${r.nodes} nút · ${r.depth} cấp · ${r.embeds} nội dung nhúng/liên kết` + (r.blocked ? ` · ${r.blocked} URL bị chặn (không an toàn)` : '') +
    (u.length ? ` · thẻ chưa hỗ trợ (đã giữ nguyên dữ liệu): ${u.join(', ')}` : '');
}
function apply() { stage.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.k})`; $('#zoomv').textContent = Math.round(V.k * 100) + '%'; renderView(); }
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
  if (sel && sel.el) sel.el.classList.remove('sel'); sel = n; 
  if (n.el) n.el.classList.add('sel');
  if (n.embed || !$('#panel').hidden) { const was = $('#panel').hidden; showPanel(n); if (was) setTimeout(() => centerOn(n), 0); }
}
function showPanel(n) {
  $('#panel').hidden = false; $('#pTitle').textContent = n.title;
  const c = $('#pBody'); c.replaceChildren();
  const pb = document.createElement('div'); pb.className = 'pb'; pb.appendChild(n.cleanBody.cloneNode(true));
  if (n.cleanNote) pb.appendChild(n.cleanNote.cloneNode(true));
  if (pb.textContent.trim() || pb.querySelector('img')) c.append(pb);
  const o = $('#pOpen'); o.hidden = !n.embed; $('#pHint').hidden = !(n.embed && n.embed.kind === 'iframe');
  if (n.embed) {
    o.href = n.embed.src;
    if (n.embed.kind === 'iframe') {
      const f = document.createElement('iframe'); f.title = n.title;
      let sb = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals';
      if (new URL(n.embed.src).origin !== location.origin) sb += ' allow-same-origin';
      f.setAttribute('sandbox', sb); f.allow = 'fullscreen; autoplay; clipboard-write; encrypted-media'; f.loading = 'lazy'; f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.src = n.embed.src; c.append(f);
    } else { const p = document.createElement('p'); p.textContent = 'Nút này là liên kết ngoài. Dùng “Mở tab mới” để xem.'; c.append(p); }
  }
}
function closePanel() { $('#panel').hidden = true; $('#pBody').replaceChildren(); setTimeout(fit, 0); }

/* Tìm kiếm tích hợp Windowing */
function search() {
  const q = norm($('#q').value.trim());
  hits.forEach(n => { if(n.el) n.el.classList.remove('hit', 'cur'); }); hits = []; hi = -1;
  if (q) hits = ALL.filter(n => n.search.includes(q));
  hits.forEach(n => { for (let p = n.parent; p; p = p.parent) p.folded = false; });
  layout(); 
  hits.forEach(n => { if(n.el) n.el.classList.add('hit'); });
  $('#qc').textContent = q ? (hits.length ? '' : 'Không có kết quả') : ''; if (hits.length) goHit(1);
}
function goHit(d) {
  if (!hits.length) return;
  if (hi >= 0 && hits[hi].el) hits[hi].el.classList.remove('cur');
  hi = (hi + d + hits.length) % hits.length; 
  centerOn(hits[hi]);
  // Sau khi centerOn, renderView sẽ chạy và n.el sẽ được sinh ra
  setTimeout(() => { if (hits[hi].el) hits[hi].el.classList.add('cur'); }, 50);
  $('#qc').textContent = `${hi + 1}/${hits.length}`;
}

/* ---------- 4. QUẢN LÝ FILE ---------- */
function openMap(text, name, opts = {}) {
  M = parseMM(text); R = M.root; curName = name; curText = text; curSrcFile = opts.file || null; sel = null; hits = [];
  $('#q').value = ''; $('#qc').textContent = ''; $('#panel').hidden = true;
  nodesContainer.replaceChildren(); // Xóa DOM cũ
  ALL = []; (function walk(n){ ALL.push(n); n.children.forEach(walk); })(R); // Chỉ build mảng Data
  $('#title').textContent = name; document.title = name + ' – MM Studio';
  $('#home').hidden = true; $('#work').hidden = false; 
  layout(); fit();
  if (!opts.noRecent) saveRecent(name, text);
}
// Các hàm loadFile, loadShared, dialog... giữ nguyên logic như cũ.
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
  } catch { }
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
  } catch { ul.innerHTML = '<li class="muted">Không tải được maps/index.json</li>'; }
}
async function loadShared(file) {
  try {
    if (!/^[\w.\-]+\.mm$/.test(file)) throw new Error('Tên sơ đồ không hợp lệ.');
    const r = await fetch('maps/' + file); if (!r.ok) throw new Error('Không tìm thấy sơ đồ “' + file + '”');
    openMap(await r.text(), file.replace(/\.mm$/, ''), { noRecent: true, file });
  } catch (e) { showErr(e.message); goHome(true); }
}
function goHome(keep) { if (!keep) history.replaceState(null, '', location.pathname); $('#work').hidden = true; $('#home').hidden = false; document.title = 'MM Studio'; listRecent(); }
function dialog(html) { $('#dlgBody').innerHTML = html; $('#dlg').showModal(); }
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function share() {
  const slug = (curSrcFile || (curName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'so-do') + '.mm');
  const url = new URL(location.href); url.search = '?map=' + encodeURIComponent(slug); url.hash = '';
  dialog(`<h3>Chia sẻ cho học sinh</h3><input readonly id="shareUrl" value="${esc(url.href)}"><p><button id="cpy">Sao chép liên kết</button> <button id="dlmm">Tải tệp .mm</button></p>`);
  $('#cpy').onclick = async () => { try { await navigator.clipboard.writeText(url.href); } catch { $('#shareUrl').select(); document.execCommand('copy'); } $('#cpy').textContent = 'Đã sao chép ✓'; };
  $('#dlmm').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([curText], { type: 'text/xml' })); a.download = slug; a.click(); };
}
function info() { dialog(`<h3>${esc(curName)}</h3><p>${esc(status())}</p><p>Định dạng <code>map version ${esc(M.version || '?')}</code>.</p>`); }

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
