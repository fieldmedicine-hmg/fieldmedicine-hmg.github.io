// V1.5 (2026-11-17) Zones & Events Management (admin dashboard): list / add / rename zones, events, shifts, aliases, archive / restore and a structured
// import (pasted CSV / TSV or an .xlsx) chunked into svEvAdmin IMPORT requests (<= 3,800 bytes each - the Worker refuses bodies above 4,096).
// Pure parsing / chunking logic is exported for Node tests (validation/run_v15_bulk_tests.js); the browser UI is built into #evHost.
// Backend contract (design section A3): svEventCatalog {includeArchived}, svEvAdmin {action, requestId, expectedVersion, ...}.
(function (root) {
  'use strict';

  var BODY_BUDGET = 3800;
  var HM = root.HMGEvents || (typeof require !== 'undefined' ? require('./hmg-events.js') : null);
  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function norm(s) { return HM ? HM.normalize(s) : str(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

  // ---------------- delimited text ----------------
  /** Text -> rows of cells (quotes, doubled quotes, CR/LF). Delimiter: tab when the first line has one, else the more frequent of ; and , */
  function parseDelimited(text) {
    var t = str(text).replace(/^﻿/, ''), first = t.split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '';
    var d = first.indexOf('\t') !== -1 ? '\t' : ((first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',');
    var rows = [], row = [], cell = '', q = false, i, ch;
    for (i = 0; i < t.length; i++) {
      ch = t.charAt(i);
      if (q) { if (ch === '"') { if (t.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"' && cell === '') q = true;
      else if (ch === d) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t.charAt(i + 1) === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return str(c).trim() !== ''; }); });
  }
  function normTime(s) {
    s = str(s).trim(); if (!s) return '';
    var m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
    return m && +m[1] <= 23 && +m[2] <= 59 ? pad2(+m[1]) + ':' + m[2] : null;
  }
  function normDate(s) {
    s = str(s).trim(); if (!s) return '';
    var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T].*)?$/.exec(s);
    if (!m) return null;
    var dk = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
    var d = new Date(dk + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dk ? dk : null;
  }
  var HEADS = { zone: ['zone', 'المنطقة'], event: ['event', 'event name', 'الفعالية'], location: ['location', 'الموقع'], dateFrom: ['date from', 'from', 'datefrom', 'start date'], dateTo: ['date to', 'to', 'dateto', 'end date'],
    shiftName: ['shift name', 'shift', 'shiftname'], start: ['start', 'shift start', 'start time'], end: ['end', 'shift end', 'end time'], aliases: ['aliases', 'alias'] };
  var ORDER = ['zone', 'event', 'location', 'dateFrom', 'dateTo', 'shiftName', 'start', 'end', 'aliases'];
  /** Rows of cells (strings) -> {events: [{zone, name, location, dateFrom, dateTo, shifts:[{name,start,end}], aliases:[]}], errors: [{line, message}]}. A header row is optional (columns by name when present, else the order Zone, Event, Location, Date From, Date To, Shift Name, Start, End, Aliases). */
  function parseEventRows(rows) {
    var errors = [], groups = {}, order = [], map = {}, startAt = 0, i;
    ORDER.forEach(function (k, ix) { map[k] = ix; });
    if (rows.length) {
      var h = rows[0].map(function (c) { return str(c).trim().toLowerCase(); }), found = {}, hits = 0;
      ORDER.forEach(function (k) { var ix = -1; HEADS[k].forEach(function (nm) { var j = h.indexOf(nm); if (ix < 0 && j >= 0) ix = j; }); if (ix >= 0) { found[k] = ix; hits++; } });
      if (found.zone !== undefined && found.event !== undefined && hits >= 2) { map = {}; ORDER.forEach(function (k) { map[k] = found[k] === undefined ? -1 : found[k]; }); startAt = 1; }
    }
    for (i = startAt; i < rows.length; i++) {
      var r = rows[i], line = i + 1, g = function (k) { return map[k] >= 0 ? str(r[map[k]]).trim() : ''; };
      var zone = g('zone'), name = g('event'), df = normDate(g('dateFrom')), dt = normDate(g('dateTo')), st = normTime(g('start')), en = normTime(g('end')), sn = g('shiftName'), bad = [];
      if (!zone) bad.push('Zone is required');
      if (!name) bad.push('Event is required');
      if (df === null) bad.push('Date From must be yyyy-mm-dd'); if (dt === null) bad.push('Date To must be yyyy-mm-dd');
      if (df && dt && dt < df) bad.push('Date To is before Date From');
      if (st === null) bad.push('Start must be HH:mm'); if (en === null) bad.push('End must be HH:mm');
      if ((sn || en) && !st) bad.push('A shift needs a Start time');
      if (bad.length) { errors.push({ line: line, message: bad.join('; ') }); continue; }
      var key = [norm(zone), norm(name), df, dt].join('|'), ev = groups[key];
      if (!ev) { ev = groups[key] = { zone: zone, name: name, location: '', dateFrom: df || '', dateTo: dt || '', shifts: [], aliases: [] }; order.push(key); }
      if (!ev.location && g('location')) ev.location = g('location');
      if (st) {
        var sname = sn || (st + (en ? '-' + en : '')), dup = ev.shifts.some(function (x) { return x.start === st && x.end === en && norm(x.name) === norm(sname); });
        if (!dup) ev.shifts.push({ name: sname, start: st, end: en });
      }
      g('aliases').split(/[|;؛]/).forEach(function (a) { a = a.trim(); if (a && !ev.aliases.some(function (x) { return norm(x) === norm(a); })) ev.aliases.push(a); });
    }
    return { events: order.map(function (k) { return groups[k]; }), errors: errors };
  }
  function parseEventsText(text) { return parseEventRows(parseDelimited(text)); }
  /** First sheet of a readWorkbook() result -> text rows (dates yyyy-mm-dd, time cells HH:mm). */
  function rowsFromWorkbook(wb, B) {
    var sh = wb.sheets[0]; if (!sh) return [];
    return sh.rows.map(function (r) { return r.map(function (c) { return B.cellStamp(c).replace(/^(\d{4}-\d{2}-\d{2}) 00:00$/, '$1'); }); });
  }

  // ---------------- chunking ----------------
  function utf8len(s) { return new TextEncoder().encode(s).length; }
  function bodyBytes(args, from, cred) {
    var b = { action: cred && cred.kind === 'device' ? 'periodAnalyticsViaDevice' : 'periodAnalytics', op: 'svEvAdmin', date: from, fromDate: from, toDate: from, opArgs: JSON.stringify(args) };
    b[cred && cred.kind === 'device' ? 'deviceToken' : 'adminToken'] = cred ? cred.value : '';
    return utf8len(JSON.stringify(b));
  }
  var ID_PLACEHOLDER = new Array(41).join('x'); // request ids are at most 40 chars
  /** Events -> {chunks: [rows[]], errors}. Each chunk's svEvAdmin IMPORT body stays <= budget bytes; an event that is too big alone is split into several rows of the SAME event (shifts / aliases spread; the backend adds missing ones idempotently). */
  function chunkImport(events, opts) {
    opts = opts || {};
    var budget = opts.budget || BODY_BUDGET, cred = opts.cred || { kind: 'admin', value: new Array(201).join('x') }, day = opts.date || '2026-01-01', errors = [];
    var size = function (rows) { return bodyBytes({ action: 'IMPORT', requestId: ID_PLACEHOLDER, rows: rows }, day, cred); };
    var pieces = [];
    events.forEach(function (ev) {
      if (size([ev]) <= budget) { pieces.push(ev); return; }
      var base = { zone: ev.zone, name: ev.name, location: ev.location, dateFrom: ev.dateFrom, dateTo: ev.dateTo, shifts: [], aliases: [] };
      if (size([base]) > budget) { errors.push({ event: ev.name, message: 'Event "' + ev.name + '" is too large for one request even without shifts (shorten the location / name).' }); return; }
      var cur = JSON.parse(JSON.stringify(base));
      var add = function (kind, item) {
        cur[kind].push(item);
        if (size([cur]) > budget) { cur[kind].pop(); pieces.push(cur); cur = JSON.parse(JSON.stringify(base)); cur[kind].push(item); }
      };
      ev.shifts.forEach(function (s) { add('shifts', s); });
      ev.aliases.forEach(function (a) { add('aliases', a); });
      pieces.push(cur);
    });
    var chunks = [], cur2 = [];
    pieces.forEach(function (p) {
      if (cur2.length && size(cur2.concat([p])) > budget) { chunks.push(cur2); cur2 = []; }
      cur2.push(p);
    });
    if (cur2.length) chunks.push(cur2);
    return { chunks: chunks, errors: errors };
  }

  var api = { parseDelimited: parseDelimited, parseEventRows: parseEventRows, parseEventsText: parseEventsText, rowsFromWorkbook: rowsFromWorkbook, chunkImport: chunkImport, bodyBytes: bodyBytes, normTime: normTime, normDate: normDate, BODY_BUDGET: BODY_BUDGET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HMGEventsAdmin = api;
  if (typeof document !== 'undefined' && document.getElementById('evHost') && root.HMGAccess) initUI();

  // ================= browser UI =================
  function initUI() {
    var A = root.HMGAccess, host = document.getElementById('evHost'), RETRY_MS = 2000;
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
    function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
    function field(label, input, wide) { var f = el('div', 'filter-field' + (wide ? ' zo-wide' : '')), l = el('label', null, label); f.appendChild(l); f.appendChild(input); return f; }
    function input(type, max, ph) { var i = el('input'); i.type = type; if (max) i.maxLength = max; if (ph) i.placeholder = ph; return i; }
    function btn(text, cls, fn) { var b = el('button', cls || 'btn-secondary', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
    function msg(node, text, err) { node.textContent = text || ''; node.className = err ? 'meta report-error' : 'meta'; }
    function today() { return A.todayRiyadh(); }
    function rid(p) { var b = new Uint8Array(8); crypto.getRandomValues(b); return p + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
    function call(op, args) { var d = today(); return A.call({ action: 'periodAnalytics', op: op, date: d, fromDate: d, toDate: d, opArgs: JSON.stringify(args || {}) }, 120000); }
    function callWrite(op, args, onBusy) {
      var n = 0;
      function go() { return call(op, args).then(function (r) { if (r && r.retryable === true && n < 3) { n++; if (onBusy) onBusy(n); return new Promise(function (res) { setTimeout(res, RETRY_MS * n); }).then(go); } return r; }); }
      return go();
    }
    function errText(r) { return (r && (r.error || r.code)) ? str(r.error || r.code) + (r.code && r.error ? ' [' + r.code + ']' : '') : 'no answer'; }
    var cat = { zones: [], events: [] }, status = el('div', 'meta'), inclArch = input('checkbox'), editEvent = null, editZone = null;

    // ----- toolbar -----
    var bar = el('div', 'filter-bar'), loadBtn = btn('Load zones & events', 'btn-primary', load), lbl = el('label', 'zo-check');
    lbl.appendChild(inclArch); lbl.appendChild(document.createTextNode(' Include archived'));
    var f0 = el('div', 'filter-field'); f0.appendChild(loadBtn); bar.appendChild(f0); var f1 = el('div', 'filter-field checkbox'); f1.appendChild(lbl); bar.appendChild(f1);
    host.appendChild(bar); host.appendChild(status);
    var zoneBox = el('div', 'zo-sub'), eventBox = el('div', 'zo-sub'), importBox = el('div', 'zo-sub');
    host.appendChild(zoneBox); host.appendChild(eventBox); host.appendChild(importBox);

    function write(payload, okText) {
      msg(status, 'Saving…');
      return callWrite('svEvAdmin', Object.assign({ requestId: rid('EV-') }, payload), function (n) { msg(status, 'Busy - retrying… (' + n + ' of 3)'); }).then(function (r) {
        if (!r || r.ok === false) { msg(status, 'Not saved: ' + errText(r), true); return null; }
        msg(status, okText || 'Saved.'); return load(true).then(function () { return r; });
      });
    }
    function zid(z) { return z.zoneId || z.id || ''; }
    function zname(z) { return z.zoneName || z.name || ''; }
    function load(keep) {
      if (keep !== true) msg(status, 'Loading…');
      return call('svEventCatalog', { includeArchived: !!inclArch.checked }).then(function (r) {
        if (!r || !r.ok) { msg(status, 'Could not load: ' + errText(r), true); return; }
        cat = { zones: r.zones || [], events: r.events || [] };
        if (keep !== true) msg(status, cat.zones.length + ' zones, ' + cat.events.length + ' events' + (r.seeded ? ' (catalog was created from the seed)' : '') + '.');
        renderZones(); renderEvents();
      });
    }
    function table(headers, rows) {
      var w = el('div', 'table-scroll'), t = el('table', 'data-table'), th = el('thead'), hr = el('tr'), tb = el('tbody');
      headers.forEach(function (h) { hr.appendChild(el('th', null, h)); }); th.appendChild(hr); t.appendChild(th);
      rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (v) { var td = el('td'); td.setAttribute('dir', 'auto'); if (v && v.nodeType) td.appendChild(v); else td.textContent = v === '' || v === null || v === undefined ? '—' : String(v); tr.appendChild(td); }); tb.appendChild(tr); });
      t.appendChild(tb); w.appendChild(t); return w;
    }
    function actions(items) { var d = el('div', 'row-actions'); items.forEach(function (b) { d.appendChild(b); }); return d; }
    function archBtn(entity, id, status0, label) {
      var archived = str(status0).toUpperCase() === 'ARCHIVED';
      return btn(archived ? 'Restore' : 'Archive', 'btn-secondary zo-mini', function () {
        if (!archived && !window.confirm('Archive ' + label + '? Nothing is deleted; it can be restored.')) return;
        write({ action: archived ? 'RESTORE' : 'ARCHIVE', entity: entity, id: id }, (archived ? 'Restored ' : 'Archived ') + label + '.');
      });
    }

    // ----- zones -----
    function renderZones() {
      clear(zoneBox); zoneBox.appendChild(el('div', 'group-title', 'Zones / المناطق'));
      zoneBox.appendChild(el('div', 'meta', 'Renaming a zone changes only its Display Name: the Zone Name used by the attendance rows never changes, so history keeps working.'));
      zoneBox.appendChild(table(['Zone ID', 'Zone Name', 'Display Name', 'City', 'Status', 'Version', 'Actions'], cat.zones.map(function (z) {
        return [zid(z), zname(z), z.displayName, z.city, z.status, z.version, actions([btn('Edit', 'btn-secondary zo-mini', function () { editZone = z; renderZoneForm(); }), archBtn('ZONE', zid(z), z.status, 'zone ' + zname(z))])];
      })));
      zoneForm = el('div'); zoneBox.appendChild(zoneForm); renderZoneForm();
    }
    var zoneForm = null;
    function renderZoneForm() {
      clear(zoneForm); var z = editZone;
      zoneForm.appendChild(el('div', 'group-title', z ? 'Edit zone ' + zname(z) : 'Add a zone / إضافة منطقة'));
      var n = input('text', 60), d = input('text', 60), c = input('text', 40), note = input('text', 200), b = el('div', 'filter-bar');
      n.value = z ? zname(z) : ''; n.disabled = !!z; d.value = z ? str(z.displayName) : ''; c.value = z ? str(z.city) : ''; note.value = z ? str(z.note) : '';
      b.appendChild(field('Zone Name (key)', n)); b.appendChild(field('Display Name', d)); b.appendChild(field('City', c)); b.appendChild(field('Note', note, true));
      var f = el('div', 'filter-field'); f.appendChild(btn(z ? 'Save zone' : 'Add zone', 'btn-primary', function () {
        if (!n.value.trim()) { msg(status, 'Zone Name is required.', true); return; }
        var p = { action: 'ZONE_SAVE', zoneName: n.value.trim(), displayName: d.value.trim(), city: c.value.trim(), note: note.value.trim() };
        if (z) { p.zoneId = zid(z); p.expectedVersion = z.version; }
        write(p, 'Zone saved.').then(function (r) { if (r) { editZone = null; renderZoneForm(); } });
      })); if (z) f.appendChild(btn('Cancel', 'btn-secondary', function () { editZone = null; renderZoneForm(); }));
      b.appendChild(f); zoneForm.appendChild(b);
    }

    // ----- events -----
    var evFilter = input('text', 60, 'filter by name / zone');
    function renderEvents() {
      clear(eventBox); eventBox.appendChild(el('div', 'group-title', 'Events & shifts / الفعاليات والورديات'));
      eventBox.appendChild(el('div', 'meta', 'An event may have no shifts ("Time not defined"). Shift times are a reference for the supervisor - they never fill a punch automatically. End later than or equal to Start is not required: an end before the start means the shift crosses midnight.'));
      var fb = el('div', 'filter-bar'); evFilter.addEventListener('input', renderEventList); fb.appendChild(field('Filter', evFilter)); eventBox.appendChild(fb);
      eventBox.appendChild(evListBox = el('div'));
      eventBox.appendChild(evFormBox = el('div'));
      renderEventList(); renderEventForm();
    }
    var evListBox = null, evFormBox = null;
    function renderEventList() {
      clear(evListBox);
      var q = norm(evFilter.value), shown = cat.events.filter(function (e) { return !q || norm(e.name + ' ' + e.zone + ' ' + (e.location || '')).indexOf(q) !== -1; });
      if (!shown.length) { evListBox.appendChild(el('div', 'meta', 'No events.')); return; }
      shown.forEach(function (e) {
        var d = el('details', 'detail-group'), s = el('summary', null, e.name + ' — ' + (e.zone || 'all zones') + ' — ' + (e.dateFrom || '…') + ' → ' + (e.dateTo || '…') + ' — ' + e.status + (e.timeDefined === false || !(e.shifts || []).length ? ' — time not defined' : ''));
        s.setAttribute('dir', 'auto'); d.appendChild(s);
        var body = el('div', 'zo-sub');
        body.appendChild(el('div', 'meta', 'Event ID ' + e.eventId + ' · version ' + e.version + (e.location ? ' · ' + e.location : '') + (e.note ? ' · ' + e.note : '') + (e.source ? ' · source ' + e.source : '')));
        body.appendChild(actions([btn('Edit event', 'btn-secondary zo-mini', function () { editEvent = e; renderEventForm(); evFormBox.scrollIntoView(); }), archBtn('EVENT', e.eventId, e.status, 'event ' + e.name)]));
        body.appendChild(el('div', 'group-title', 'Shifts'));
        body.appendChild(table(['Name', 'Start', 'End', 'Crosses midnight', 'Status', 'Actions'], (e.shifts || []).map(function (s0) {
          return [s0.name, s0.start, s0.end || 'not given', s0.crossesMidnight ? '+1 day' : '', s0.status, actions([btn('Edit', 'btn-secondary zo-mini', function () { shiftForm(body, e, s0); }), archBtn('SHIFT', s0.shiftId, s0.status, 'shift ' + s0.name)])];
        })));
        var shHost = el('div'); body.appendChild(shHost); body.shHost = shHost; shiftForm(body, e, null);
        body.appendChild(el('div', 'group-title', 'Aliases (other spellings the supervisor may see)'));
        body.appendChild(table(['Alias', 'Source', 'Status', 'Actions'], (e.aliases || []).map(function (a) {
          return [a.alias, a.source, a.status, actions([archBtn('ALIAS', a.aliasId, a.status, 'alias ' + a.alias)])];
        })));
        var ai = input('text', 120), ab = el('div', 'filter-bar'), af = el('div', 'filter-field');
        af.appendChild(btn('Add alias', 'btn-primary zo-mini', function () { if (!ai.value.trim()) { msg(status, 'Enter the alias.', true); return; } write({ action: 'ALIAS_SAVE', eventId: e.eventId, alias: ai.value.trim(), status: 'ACTIVE' }, 'Alias added.'); }));
        ab.appendChild(field('New alias', ai, true)); ab.appendChild(af); body.appendChild(ab);
        d.appendChild(body); evListBox.appendChild(d);
      });
    }
    function shiftForm(body, e, s0) {
      var h = body.shHost; clear(h);
      var n = input('text', 60), st = input('time'), en = input('time'), b = el('div', 'filter-bar'), f = el('div', 'filter-field');
      n.value = s0 ? str(s0.name) : ''; st.value = s0 ? str(s0.start) : ''; en.value = s0 ? str(s0.end) : '';
      b.appendChild(field(s0 ? 'Edit shift' : 'New shift name', n)); b.appendChild(field('Start', st)); b.appendChild(field('End (optional)', en));
      f.appendChild(btn(s0 ? 'Save shift' : 'Add shift', 'btn-primary zo-mini', function () {
        if (!st.value) { msg(status, 'The shift needs a start time.', true); return; }
        var p = { action: 'SHIFT_SAVE', eventId: e.eventId, name: n.value.trim() || (st.value + (en.value ? '-' + en.value : '')), start: st.value, end: en.value };
        if (s0) { p.shiftId = s0.shiftId; p.expectedVersion = s0.version; }
        write(p, 'Shift saved.');
      })); if (s0) f.appendChild(btn('Cancel', 'btn-secondary zo-mini', function () { shiftForm(body, e, null); }));
      b.appendChild(f); h.appendChild(b);
    }
    function renderEventForm() {
      clear(evFormBox); var e = editEvent;
      evFormBox.appendChild(el('div', 'group-title', e ? 'Edit event ' + e.name : 'Add an event / إضافة فعالية'));
      var zs = el('select'), n = input('text', 120), loc = input('text', 120), df = input('date'), dt = input('date'), note = input('text', 200), b = el('div', 'filter-bar');
      var blank = el('option', null, '(all zones)'); blank.value = ''; zs.appendChild(blank);
      cat.zones.forEach(function (z) { var o = el('option', null, zname(z) + (z.displayName && z.displayName !== zname(z) ? ' — ' + z.displayName : '')); o.value = zname(z); zs.appendChild(o); });
      zs.value = e ? str(e.zone) : ''; n.value = e ? str(e.name) : ''; loc.value = e ? str(e.location) : ''; df.value = e ? str(e.dateFrom) : ''; dt.value = e ? str(e.dateTo) : ''; note.value = e ? str(e.note) : '';
      b.appendChild(field('Zone', zs)); b.appendChild(field('Event name', n, true)); b.appendChild(field('Location', loc)); b.appendChild(field('Date From', df)); b.appendChild(field('Date To', dt)); b.appendChild(field('Note', note, true));
      var f = el('div', 'filter-field'); f.appendChild(btn(e ? 'Save event' : 'Add event', 'btn-primary', function () {
        if (!n.value.trim()) { msg(status, 'The event name is required.', true); return; }
        if (df.value && dt.value && dt.value < df.value) { msg(status, 'Date To is before Date From.', true); return; }
        var p = { action: 'EVENT_SAVE', zone: zs.value, name: n.value.trim(), location: loc.value.trim(), dateFrom: df.value, dateTo: dt.value, note: note.value.trim() };
        if (e) { p.eventId = e.eventId; p.expectedVersion = e.version; }
        write(p, 'Event saved.').then(function (r) { if (r) { editEvent = null; renderEventForm(); } });
      })); if (e) f.appendChild(btn('Cancel', 'btn-secondary', function () { editEvent = null; renderEventForm(); }));
      b.appendChild(f); evFormBox.appendChild(b);
      importBox.hidden = false;
    }

    // ----- import -----
    var imText = el('textarea'), imFile = input('file'), imStatus = el('div', 'meta'), imTable = el('div'), parsed = null, imBusy = false, imGo;
    imText.rows = 6; imText.setAttribute('dir', 'auto'); imText.placeholder = 'Zone\tEvent\tLocation\tDate From\tDate To\tShift Name\tStart\tEnd\tAliases'; imFile.accept = '.xlsx,.csv,.tsv,.txt';
    importBox.appendChild(el('div', 'group-title', 'Structured import / استيراد منظم'));
    importBox.appendChild(el('div', 'meta', 'Paste rows from Excel / CSV / TSV, or choose an .xlsx / .csv file. Columns: Zone, Event, Location, Date From, Date To, Shift Name, Start, End, Aliases (several aliases separated by | or ;). Dates yyyy-mm-dd, times HH:mm. Rows of the same event are merged. Re-importing is safe: an existing event only receives the missing shifts / aliases.'));
    var ib = el('div', 'filter-bar'); ib.appendChild(field('Pasted rows', imText, true)); ib.appendChild(field('or a file', imFile));
    var ibf = el('div', 'filter-field'); ibf.appendChild(btn('Check rows', 'btn-secondary', parseInput));
    imGo = btn('Import', 'btn-primary', runImport); imGo.disabled = true; ibf.appendChild(imGo); ib.appendChild(ibf);
    importBox.appendChild(ib); importBox.appendChild(imStatus); importBox.appendChild(imTable);
    function parseInput() {
      var f = imFile.files && imFile.files[0]; parsed = null; imGo.disabled = true; clear(imTable);
      function done(rows) {
        var p = parseEventRows(rows); parsed = p;
        var sh = 0, al = 0; p.events.forEach(function (e) { sh += e.shifts.length; al += e.aliases.length; });
        msg(imStatus, p.events.length + ' events, ' + sh + ' shifts, ' + al + ' aliases' + (p.errors.length ? ', ' + p.errors.length + ' rows with errors (they are skipped)' : '') + '.', p.errors.length > 0);
        if (p.errors.length) imTable.appendChild(table(['Line', 'Problem'], p.errors.slice(0, 100).map(function (x) { return [x.line, x.message]; })));
        imTable.appendChild(table(['Zone', 'Event', 'Dates', 'Shifts', 'Aliases'], p.events.slice(0, 200).map(function (e) { return [e.zone, e.name, (e.dateFrom || '…') + ' → ' + (e.dateTo || '…'), e.shifts.map(function (s) { return s.start + (s.end ? '-' + s.end : ''); }).join(', '), e.aliases.join(' | ')]; })));
        imGo.disabled = !p.events.length; imGo.textContent = 'Import ' + p.events.length + ' events';
      }
      if (f && /\.xlsx$/i.test(f.name)) {
        if (!root.HMGBulk) { msg(imStatus, 'The Excel reader is not loaded.', true); return; }
        f.arrayBuffer().then(function (ab) { return root.HMGBulk.readWorkbook(new Uint8Array(ab)); }).then(function (wb) { done(rowsFromWorkbook(wb, root.HMGBulk)); }, function (e) { msg(imStatus, 'Could not read the file: ' + (e && e.message || e), true); });
      } else if (f) { f.text().then(function (t) { done(parseDelimited(t)); }); }
      else done(parseDelimited(imText.value));
    }
    function runImport() {
      if (imBusy || !parsed || !parsed.events.length) return;
      var ck = chunkImport(parsed.events, { cred: A.credential(), date: today() });
      if (ck.errors.length) { msg(imStatus, ck.errors[0].message, true); return; }
      if (!window.confirm('Import ' + parsed.events.length + ' events in ' + ck.chunks.length + ' request(s)?')) return;
      imBusy = true; imGo.disabled = true; var total = { events: 0, shifts: 0, aliases: 0 }, i = 0;
      function next() {
        if (i >= ck.chunks.length) { imBusy = false; msg(imStatus, 'Import finished: ' + ck.chunks.length + ' request(s) processed.'); return load(true); }
        var rows = ck.chunks[i];
        // the request id follows the content, so a retry of the same chunk is idempotent
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows))).then(function (buf) {
          var u = new Uint8Array(buf), h = ''; for (var k = 0; k < 8; k++) h += ('0' + u[k].toString(16)).slice(-2);
          msg(imStatus, 'Importing request ' + (i + 1) + ' of ' + ck.chunks.length + '…');
          return callWrite('svEvAdmin', { action: 'IMPORT', requestId: 'EVI-' + h, rows: rows }, function (n) { msg(imStatus, 'Busy - retrying… (' + n + ' of 3)'); });
        }).then(function (r) {
          if (!r || r.ok === false) { imBusy = false; imGo.disabled = false; msg(imStatus, 'Stopped at request ' + (i + 1) + ' of ' + ck.chunks.length + ': ' + errText(r) + ' - press Import again (safe: finished parts are recognised).', true); return load(true); }
          total.events += 1; i++; return next();
        });
      }
      next();
    }
    importBox.hidden = false;
    A.onChange(function (st) { if (st && st.code === 'AUTHORIZED' && !cat.events.length) load(); });
    renderZones(); renderEvents();
  }
})(typeof window !== 'undefined' ? window : globalThis);
