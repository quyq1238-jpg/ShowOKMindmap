'use strict';
/* MM Studio – Chế độ trình chiếu + chú thích. Dùng chung V, vp, stage, fit, apply, zoomAt, ... của app.js.
   Nét vẽ nằm trong SVG #ink bên trong #stage nên dùng tọa độ "thế giới" (đã bỏ pan/zoom): luôn khớp khi zoom/pan/resize. */
(() => {
  const work = $('#work'), ink = $('#ink'), cap = $('#inkcap'), las = $('#laser'), tb = $('#ptool'), bar = $('#bar');
  const NS = 'http://www.w3.org/2000/svg';
  let pres = false, tool = 'select', color = '#e03131', width = 4, strokes = [], undoS = [], redoS = [];
  let saved = null, fsOn = false, drawing = null, erased = null, pid = null, hidden = false, trail = [], raf = 0, saveT = 0, seq = 0;
  const poly = document.createElementNS(NS, 'polyline'), dot = document.createElementNS(NS, 'circle');
  poly.setAttribute('fill', 'none'); poly.setAttribute('stroke-linecap', 'round'); poly.setAttribute('stroke-linejoin', 'round'); dot.setAttribute('r', 9);
  las.append(poly, dot);
  document.querySelectorAll('button[title]').forEach(b => b.setAttribute('aria-label', b.title));

  const pt = e => { const r = vp.getBoundingClientRect(); return [(e.clientX - r.left - V.x) / V.k, (e.clientY - r.top - V.y) / V.k]; };
  const f1 = n => Math.round(n * 10) / 10;
  const dOf = p => p.length === 1 ? `M${p[0][0]},${p[0][1]}L${p[0][0]},${p[0][1]}` : 'M' + p.map(a => a[0] + ',' + a[1]).join('L');
  function mk(s) {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', s.d || (s.d = dOf(s.pts))); el.setAttribute('stroke', s.color); el.setAttribute('stroke-width', s.w);
    if (s.tool === 'marker') { el.setAttribute('stroke-opacity', '.35'); el.style.mixBlendMode = 'multiply'; }
    return (s.el = el);
  }
  const key = () => 'mmstudio.ink.' + curName;
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { strokes.length ? localStorage.setItem(key(), JSON.stringify(strokes.map(({ id, tool, color, w, pts }) => ({ id, tool, color, w, pts })))) : localStorage.removeItem(key()); } catch { /* đầy/bị chặn */ } }, 300);
  }
  function load() {
    try {
      const l = JSON.parse(localStorage.getItem(key()) || '[]'); if (!Array.isArray(l)) return;
      for (const s of l.slice(0, 5000)) {
        if (!s || !['pen', 'marker'].includes(s.tool) || !/^#[0-9a-f]{6}$/i.test(s.color) || !(s.w > 0 && s.w < 1000) || !Array.isArray(s.pts) || !s.pts.length) continue;
        if (!s.pts.every(p => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]))) continue;
        const o = { id: ++seq, tool: s.tool, color: s.color, w: s.w, pts: s.pts }; strokes.push(o); ink.append(mk(o));
      }
    } catch { /* dữ liệu lỗi: bỏ qua */ }
  }
  // Gắn vào openMap (không sửa logic cũ): nạp chú thích riêng cho từng sơ đồ
  const _open = openMap;
  openMap = function (...a) { _open.apply(this, a); ink.replaceChildren(); strokes = []; undoS = []; redoS = []; setHidden(false); load(); upd(); };

  function upd() {
    tb.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === tool));
    tb.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', b.dataset.color === color));
    $('#pUndo').disabled = !undoS.length; $('#pRedo').disabled = !redoS.length; $('#pClear').disabled = !strokes.length;
    $('#pEye').setAttribute('aria-pressed', hidden); $('#pEye').firstElementChild.firstElementChild.setAttribute('href', hidden ? '#i-eyeoff' : '#i-eye');
  }
  function setHidden(h) { hidden = h; ink.style.display = h ? 'none' : ''; upd(); }
  function setTool(t) {
    tool = t; tb.dataset.tool = t; cap.className = t; cap.hidden = !(pres && t !== 'select'); trail = []; dot.style.display = 'none'; poly.setAttribute('points', ''); upd();
  }

  /* ----- vẽ / tẩy / laser ----- */
  const segD = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l, 0, 1) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  function eraseAt(e) {
    const p = pt(e), r = 14 / V.k;
    for (const s of strokes.slice()) {
      const rr = r + s.w / 2; let hit = s.pts.length === 1 ? Math.hypot(p[0] - s.pts[0][0], p[1] - s.pts[0][1]) <= rr : false;
      for (let i = 1; !hit && i < s.pts.length; i++) hit = segD(p, s.pts[i - 1], s.pts[i]) <= rr;
      if (hit) { s.el.remove(); strokes.splice(strokes.indexOf(s), 1); erased.push(s); }
    }
  }
  function lasPush(e) {
    const r = vp.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    trail.push([x, y, performance.now()]); dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('fill', color); dot.style.display = '';
    poly.setAttribute('stroke', color); poly.setAttribute('stroke-opacity', '.5'); poly.setAttribute('stroke-width', 6);
    if (!raf) raf = requestAnimationFrame(lasFrame);
  }
  function lasFrame() {
    const now = performance.now(); trail = trail.filter(p => now - p[2] < 450);
    poly.setAttribute('points', trail.map(p => p[0] + ',' + p[1]).join(' '));
    raf = trail.length ? requestAnimationFrame(lasFrame) : 0;
  }
  const stop = e => e.stopPropagation();
  cap.addEventListener('pointerdown', e => {
    stop(e); if (drawing || erased || (e.pointerType === 'mouse' && e.button !== 0)) return; e.preventDefault();
    try { cap.setPointerCapture(e.pointerId); } catch { } pid = e.pointerId;
    if (tool === 'pen' || tool === 'marker') {
      if (hidden) setHidden(false);
      const p = pt(e).map(f1); drawing = { id: ++seq, tool, color, w: f1((tool === 'marker' ? width * 3 : width) / V.k), pts: [p] };
      drawing.d = dOf(drawing.pts); ink.append(mk(drawing));
    } else if (tool === 'eraser') { erased = []; eraseAt(e); } else if (tool === 'laser') lasPush(e);
  });
  cap.addEventListener('pointermove', e => {
    stop(e);
    if (tool === 'laser') return lasPush(e);
    if (e.pointerId !== pid) return;
    if (drawing) {
      for (const c of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) { const p = pt(c).map(f1), l = drawing.pts[drawing.pts.length - 1]; if (p[0] === l[0] && p[1] === l[1]) continue; drawing.pts.push(p); drawing.d += 'L' + p[0] + ',' + p[1]; }
      drawing.el.setAttribute('d', drawing.d);
    } else if (erased) eraseAt(e);
  });
  function end(e) {
    stop(e);
    if (drawing) { strokes.push(drawing); undoS.push({ t: 'add', l: [drawing] }); redoS = []; drawing = null; persist(); }
    else if (erased) { if (erased.length) { undoS.push({ t: 'del', l: erased }); redoS = []; persist(); } erased = null; }
    pid = null; if (e.pointerType !== 'mouse') dot.style.display = 'none'; upd();
  }
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => cap.addEventListener(t, end));
  cap.addEventListener('pointerleave', () => { if (!drawing) dot.style.display = 'none'; });
  cap.addEventListener('click', stop);

  function apply2(a, rev) {
    const add = (a.t === 'add') !== rev;
    for (const s of a.l) { if (add) { strokes.push(s); ink.append(s.el); } else { s.el.remove(); strokes.splice(strokes.indexOf(s), 1); } }
  }
  const doUndo = () => { const a = undoS.pop(); if (!a) return; apply2(a, true); redoS.push(a); persist(); upd(); };
  const doRedo = () => { const a = redoS.pop(); if (!a) return; apply2(a, false); undoS.push(a); persist(); upd(); };
  function clearAll() {
    if (!strokes.length || !confirm('Xóa toàn bộ chú thích? (Có thể hoàn tác bằng Ctrl+Z ngay sau đó)')) return;
    const l = strokes; l.forEach(s => s.el.remove()); strokes = []; undoS.push({ t: 'del', l }); redoS = []; persist(); upd();
  }

  /* ----- vào / thoát trình chiếu ----- */
  function enter(t) {
    if (!M || work.hidden) return; if (pres) return setTool(t);
    saved = { x: V.x, y: V.y, k: V.k, panel: !$('#panel').hidden }; pres = true; work.classList.add('pres'); tb.hidden = false; tb.classList.remove('min'); bar.classList.remove('open');
    try { const p = work.requestFullscreen && work.requestFullscreen(); p && p.then(() => { fsOn = true; }).catch(() => { }); } catch { }
    setTool(t);
  }
  function exit() {
    if (!pres) return; pres = false; work.classList.remove('pres'); tb.hidden = true; setTool('select');
    if (!saved.panel && !$('#panel').hidden) closePanel();
    if (document.fullscreenElement) { fsOn = false; document.exitFullscreen().catch(() => { }); }
    const s = saved, back = () => { V.x = s.x; V.y = s.y; V.k = s.k; apply(); }; back(); setTimeout(back, 450); // sau khi resize/fullscreen của app.js (fit) chạy xong
  }
  document.addEventListener('fullscreenchange', () => { if (pres && fsOn && !document.fullscreenElement) { fsOn = false; exit(); } });

  /* ----- gắn nút ----- */
  $('#bPresent').onclick = () => enter('select'); $('#pExit').onclick = exit;
  $('#bMore').onclick = () => { const o = bar.classList.toggle('open'); $('#bMore').setAttribute('aria-expanded', o); };
  $('#pMin').onclick = () => tb.classList.toggle('min');
  tb.addEventListener('click', e => {
    const t = e.target.closest('[data-tool]'), c = e.target.closest('[data-color]');
    if (t) setTool(t.dataset.tool === tool && tool !== 'select' ? 'select' : t.dataset.tool);
    if (c) { color = c.dataset.color; upd(); }
  });
  $('#pWidth').oninput = e => { width = +e.target.value; };
  $('#pUndo').onclick = doUndo; $('#pRedo').onclick = doRedo; $('#pClear').onclick = clearAll; $('#pEye').onclick = () => setHidden(!hidden);

  const names = { p: 'pen', m: 'marker', l: 'laser', e: 'eraser', v: 'select' };
  document.addEventListener('keydown', e => {
    if (work.hidden || $('#dlg').open || e.target.matches('input,textarea,select,[contenteditable]')) return;
    const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey; let used = true;
    if (c && (k === 'z' || k === 'y')) { if (!pres) return; (k === 'y' || e.shiftKey) ? doRedo() : doUndo(); }
    else if (c || e.altKey) return;
    else if (!pres) { if (k === 'p') enter('pen'); else return; }
    else if (k === 'escape') { tool !== 'select' ? setTool('select') : exit(); }
    else if (names[k]) setTool(names[k] === tool && tool !== 'select' ? 'select' : names[k]);
    else if (k === 'h') setHidden(!hidden);
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  upd();
})();
