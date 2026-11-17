// V1.5 (2026-11-17) Bulk attendance Excel: "Export All Attendance (editable)" + "Import Attendance Corrections" (admin dashboard).
// Pure logic first (module.exports, unit-tested in Node by validation/run_v15_bulk_tests.js), browser UI at the bottom.
//   template rows / sheets -> HMGXlsxPro (xlsx-pro.js); minimal xlsx READER (zip + XML, DecompressionStream('deflate-raw'));
//   row validation + classification; request packing for svCorrectBatch (EXACT V1.4.1 compact encoding, <= 25 items, <= 3,800 bytes, one 31-day window).
// Nothing here writes a punch on its own: the import only ever sends svCorrectBatch (adminOverride + directApproval) after a preview and an explicit Apply.
(function (root) {
  'use strict';

  var COLUMNS = ['Record ID', 'Employee Code', 'Employee Name', 'Work Date', 'Zone', 'Event', 'Original Check-in', 'Original Check-out', 'Effective Check-in',
    'Effective Check-out', 'New Check-in', 'New Check-out', 'New Event', 'New Zone', 'Attendance Status', 'Approval Status', 'Effective Working Hours',
    'Action', 'Row Version', 'Review Note'];
  var COL_TYPES = ['string', 'string', 'text', 'date', 'text', 'text', 'datetime', 'datetime', 'datetime', 'datetime', 'newtime', 'newtime', 'text', 'text', 'text', 'text', 'duration', 'text', 'string', 'text'];
  var COL_WIDTHS = [34, 14, 26, 12, 18, 26, 18, 18, 18, 18, 18, 18, 22, 18, 16, 22, 14, 12, 14, 34];
  var EDIT_COLS = { 'New Check-in': 1, 'New Check-out': 1, 'New Event': 1, 'New Zone': 1, 'Action': 1 };
  var BODY_BUDGET = 3800, BATCH_MAX = 25, MAX_DAYS = 31, MAX_SPAN_MIN = 1440;
  var BATCH_ID_PLACEHOLDER = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // 34 chars (batch ids are shorter than this)

  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isDK(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function dkMs(dk) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dk); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  function addDay(dk, n) { return new Date(dkMs(dk) + n * 86400000).toISOString().slice(0, 10); }
  function dayGap(a, b) { return Math.round((dkMs(b) - dkMs(a)) / 86400000); }
  /** 'yyyy-MM-dd HH:mm[:ss]' (or with T) -> 'yyyy-MM-dd HH:mm' | ''. */
  function normDT(s) {
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(str(s).trim());
    return m ? m[1] + ' ' + m[2] + ':' + m[3] : '';
  }
  function dtMs(s) { var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN; }
  function fromSerial(n) { // Excel serial -> {date:'yyyy-MM-dd', time:'HH:mm', frac:bool}; minute precision, no time-zone shift
    var total = Math.floor(n * 1440 + 0.001), day = Math.floor(total / 1440), min = total - day * 1440;
    return { date: new Date(Date.UTC(1970, 0, 1) + (day - 25569) * 86400000).toISOString().slice(0, 10), time: pad2(Math.floor(min / 60)) + ':' + pad2(min % 60), timeOnly: n < 1 && n >= 0, hasTime: min !== 0 };
  }

  // ---------------- sha12 ----------------
  function subtle() {
    var c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && c.subtle) return c.subtle;
    if (typeof require !== 'undefined') return require('crypto').webcrypto.subtle;
    throw new Error('SubtleCrypto is not available');
  }
  /** First 12 hex chars of SHA-256 (UTF-8) - the backend compares svSha_(rowStamp).slice(0, 12). */
  function sha12(s) {
    return subtle().digest('SHA-256', new TextEncoder().encode(String(s))).then(function (buf) {
      var u = new Uint8Array(buf), h = ''; for (var i = 0; i < 6; i++) h += ('0' + u[i].toString(16)).slice(-2); return h;
    });
  }
  /** Adds stampHash + rowVersion ("<correction version>|<sha12 rowStamp>") to every svList record. */
  function prepareRecords(records) {
    return Promise.all(records.map(function (r) { return sha12(r.rowStamp); })).then(function (hs) {
      records.forEach(function (r, i) { r.stampHash = hs[i]; r.rowVersion = (r.version === undefined || r.version === null ? 0 : r.version) + '|' + hs[i]; });
      return records;
    });
  }

  // ---------------- record accessors (svList record shape, V1.5) ----------------
  function effOf(r) { var e = r.effective || r.current || { checkIn: r.checkIn, checkOut: r.checkOut }; return { checkIn: normDT(e.checkIn), checkOut: normDT(e.checkOut) }; }
  function origOf(r) { var o = r.original || r.recorded || {}; return { checkIn: normDT(o.checkIn), checkOut: normDT(o.checkOut) }; }
  function attOf(r) { var e = effOf(r); return r.attendance || (e.checkIn && e.checkOut ? 'MATCH' : e.checkIn ? 'CHECK_IN_ONLY' : e.checkOut ? 'CHECK_OUT_ONLY' : ''); }

  // ---------------- template ----------------
  function hoursMin(r) {
    if (r.effectiveMinutes !== undefined && r.effectiveMinutes !== null && r.effectiveMinutes !== '') return Number(r.effectiveMinutes);
    var e = effOf(r); if (e.checkIn && e.checkOut) { var d = (dtMs(e.checkOut) - dtMs(e.checkIn)) / 60000; return d > 0 ? d : ''; } return '';
  }
  /** One svList record -> the 20 template cells (strings for dates/times, 'yyyy-MM-dd HH:mm'). note = Review Note. */
  function templateRow(r, note) {
    var o = origOf(r), e = effOf(r), h = hoursMin(r);
    return [str(r.recordId), str(r.employeeCode), str(r.employeeName), str(r.workDate), str(r.zone), str(r.event), o.checkIn, o.checkOut, e.checkIn, e.checkOut,
      '', '', '', '', attOf(r), str(r.approvalLabel), h, 'NO_CHANGE', str(r.rowVersion), note || ''];
  }
  /** Same code, Check-in Only in zone A and Check-out Only in zone B, check-out 0-16 h after the check-in -> Set of caseKeys (both sides). */
  function crossZoneKeys(records) {
    var byCode = {}, keys = {};
    records.forEach(function (r) { (byCode[str(r.employeeCode)] = byCode[str(r.employeeCode)] || []).push(r); });
    Object.keys(byCode).forEach(function (c) {
      var list = byCode[c], ins = list.filter(function (r) { return attOf(r) === 'CHECK_IN_ONLY'; }), outs = list.filter(function (r) { return attOf(r) === 'CHECK_OUT_ONLY'; });
      ins.forEach(function (a) {
        outs.forEach(function (b) {
          if (str(a.zone) === str(b.zone)) return;
          var d = (dtMs(effOf(b).checkOut) - dtMs(effOf(a).checkIn)) / 3600000;
          if (d >= 0 && d <= 16) { keys[a.caseKey || a.recordId] = true; keys[b.caseKey || b.recordId] = true; }
        });
      });
    });
    return keys;
  }
  function specialReason(r, cross) {
    var a = [];
    if (r.final) a.push('FINAL zone-day (read-only)');
    if (r.sourceConflict) a.push('Source conflict: a real punch arrived after the approval');
    if (r.approvalLabel === 'REJECTED') a.push('Rejected by the Zone Manager');
    if (!str(r.zone).trim()) a.push('Unmapped zone');
    if (cross[r.caseKey || r.recordId]) a.push('Cross-zone candidate (Check-in Only here, Check-out Only in another zone)');
    return a.join('; ');
  }
  var INSTRUCTIONS = [
    { v: 'HMG attendance - editable template', style: 'title' },
    'Edit ONLY the yellow cells: New Check-in, New Check-out, New Event, New Zone and Action. Every other cell is protected (no password - this only prevents accidents).',
    'Action: choose APPLY to submit the row, or leave NO_CHANGE. Rows with NO_CHANGE are ignored even when New values are filled in.',
    'New Check-in / New Check-out: type a full date-time (2026-11-02 14:30) or only a time (14:30). A time-only check-in is on the Work Date; a time-only check-out earlier than or equal to the check-in is on the NEXT day (overnight).',
    'A blank New cell keeps the current Effective value. The result must have both a check-in and a check-out, check-out after check-in, at most 24 hours apart.',
    'New Event / New Zone: filling either one makes the row REQUIRES_APPROVAL - the import never reassigns an event or zone (the Zone Manager decides).',
    'Row Version identifies the version the row was exported from. If the record changed afterwards the import reports CONFLICT and applies nothing for that row.',
    'FINAL zone-days, records without any real punch and rows outside your access are refused. Review_Special lists cross-zone candidates, rejected, source-conflict, FINAL and unmapped rows.',
    'Import: Control Center > Import Attendance Corrections. Upload this file, read the preview (counts), then press Apply. Uploading the same file again never creates a second correction.',
    'Employee Code is text (leading zeros are kept). Do not insert, delete or rename columns and do not change the Record ID.'
  ];

  /** records (prepared svList records) -> {sheets, counts}. opts: {from, to, generatedAt, zoneFilter} */
  function buildTemplate(records, opts) {
    opts = opts || {};
    var cross = crossZoneKeys(records), zones = {}, special = [], counts = { total: records.length, zones: {}, special: 0 };
    var sorted = records.slice().sort(function (a, b) { return str(a.workDate) < str(b.workDate) ? -1 : str(a.workDate) > str(b.workDate) ? 1 : str(a.employeeCode) < str(b.employeeCode) ? -1 : str(a.employeeCode) > str(b.employeeCode) ? 1 : 0; });
    sorted.forEach(function (r) {
      var why = specialReason(r, cross);
      if (why) { special.push(templateRow(r, why)); counts.special++; }
      else { var z = str(r.zone); (zones[z] = zones[z] || []).push(templateRow(r, '')); }
    });
    var cols = COLUMNS.map(function (h, i) { return { header: h, type: COL_TYPES[i], width: COL_WIDTHS[i], edit: !!EDIT_COLS[h] }; });
    var actionIdx = COLUMNS.indexOf('Action');
    function dataSheet(name, rows, tab) {
      return { name: name, columns: cols, rows: rows, protect: true, tabColor: tab, validations: [{ col: actionIdx, list: ['APPLY', 'NO_CHANGE'], title: 'Action', error: 'Choose APPLY or NO_CHANGE.', prompt: 'APPLY submits the row; NO_CHANGE ignores it.' }] };
    }
    var zoneNames = Object.keys(zones).sort(), sheets = [];
    sheets.push({ name: 'Instructions', header: false, columns: [{ header: '', type: 'wrap', width: 130 }], rows: INSTRUCTIONS.map(function (t) { return [t]; }), protect: true, tabColor: 'FF2E75B6' });
    var sumRows = [], totals = [0, 0, 0, 0, 0];
    zoneNames.forEach(function (z) {
      var rows = zones[z], c = [rows.length, 0, 0, 0];
      rows.forEach(function (r) { var a = r[14]; if (a === 'MATCH') c[1]++; else if (a === 'CHECK_IN_ONLY') c[2]++; else if (a === 'CHECK_OUT_ONLY') c[3]++; });
      counts.zones[z] = rows.length;
      sumRows.push([z || '(no zone)', c[0], c[1], c[2], c[3]]);
      for (var i = 0; i < 4; i++) totals[i] += c[i];
    });
    sumRows.push([{ v: 'Zone sheets total', style: 'bold' }, totals[0], totals[1], totals[2], totals[3]]);
    sumRows.push([{ v: 'Review_Special', style: 'bold' }, special.length, '', '', '']);
    sumRows.push(['', '', '', '', '']);
    sumRows.push([{ v: 'From', style: 'bold' }, str(opts.from), '', '', '']);
    sumRows.push([{ v: 'To', style: 'bold' }, str(opts.to), '', '', '']);
    sumRows.push([{ v: 'Generated', style: 'bold' }, str(opts.generatedAt), '', '', '']);
    sumRows.push([{ v: 'Records', style: 'bold' }, records.length, '', '', '']);
    sheets.push({ name: 'Summary', columns: [{ header: 'Zone', width: 30 }, { header: 'Records', type: 'number', width: 12 }, { header: 'MATCH', type: 'number', width: 12 }, { header: 'CHECK_IN_ONLY', type: 'number', width: 16 }, { header: 'CHECK_OUT_ONLY', type: 'number', width: 16 }],
      rows: sumRows, protect: true, autoFilter: false, tabColor: 'FF2E75B6' });
    zoneNames.forEach(function (z) { sheets.push(dataSheet(z || 'No zone', zones[z], 'FF70AD47')); });
    sheets.push(dataSheet('Review_Special', special, 'FFC00000'));
    return { sheets: sheets, counts: counts };
  }

  // ---------------- xlsx reader (zip + XML) ----------------
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function inflateRaw(u8) {
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  var MAX_ENTRY = 150 * 1024 * 1024;
  function zipEntries(b) {
    var e = -1, i;
    for (i = b.length - 22; i >= Math.max(0, b.length - 22 - 65557); i--) if (b[i] === 0x50 && b[i + 1] === 0x4B && b[i + 2] === 0x05 && b[i + 3] === 0x06) { e = i; break; }
    if (e < 0) throw new Error('Not an .xlsx file (zip directory not found).');
    var n = u16(b, e + 10), off = u32(b, e + 16), map = {}, dec = new TextDecoder();
    for (i = 0; i < n; i++) {
      if (u32(b, off) !== 0x02014B50) throw new Error('Corrupt zip directory.');
      var nl = u16(b, off + 28), xl = u16(b, off + 30), cl = u16(b, off + 32);
      map[dec.decode(b.subarray(off + 46, off + 46 + nl))] = { method: u16(b, off + 10), csize: u32(b, off + 20), usize: u32(b, off + 24), lho: u32(b, off + 42) };
      off += 46 + nl + xl + cl;
    }
    return map;
  }
  function entryBytes(b, ent) {
    if (ent.usize > MAX_ENTRY) throw new Error('A file inside the workbook is too large.');
    var lh = ent.lho;
    if (u32(b, lh) !== 0x04034B50) throw new Error('Corrupt zip entry.');
    var start = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28), data = b.subarray(start, start + ent.csize);
    if (ent.method === 0) return Promise.resolve(data);
    if (ent.method === 8) return inflateRaw(data);
    throw new Error('Unsupported zip compression method ' + ent.method + '.');
  }
  function xmlText(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, g) {
      if (g === 'amp') return '&'; if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'quot') return '"'; if (g === 'apos') return "'";
      return String.fromCodePoint(g.charAt(1) === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
    }).replace(/_x([0-9A-Fa-f]{4})_/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
  }
  function attrs(tag) { var o = {}, re = /([\w:.-]+)\s*=\s*"([^"]*)"/g, m; while ((m = re.exec(tag))) o[m[1]] = xmlText(m[2]); return o; }
  function tTexts(block) { var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g, m; while ((m = re.exec(block))) out += m[1] ? xmlText(m[1]) : ''; return out; }
  function colIndex(ref) { var m = /^([A-Z]+)/.exec(ref), n = 0; if (!m) return -1; for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64); return n - 1; }
  var BUILTIN_DATE = { 14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 27: 1, 28: 1, 29: 1, 30: 1, 31: 1, 32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 45: 1, 46: 1, 47: 1, 50: 1, 51: 1, 52: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1 };
  function isDateCode(code) {
    var c = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(h+|m+|s+)\]/gi, '$1').replace(/\[[^\]]*\]/g, '').replace(/_./g, '').replace(/\*./g, '');
    return /[ymdhs]/i.test(c) && !/^general$/i.test(c.trim());
  }
  function parseStyles(xml) {
    var fmts = {}, re = /<numFmt\b([^>]*)\/?>/g, m;
    while ((m = re.exec(xml))) { var a = attrs(m[1]); fmts[a.numFmtId] = a.formatCode || ''; }
    var block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml), dates = [];
    if (block) { var xr = /<xf\b([^>]*?)\/?>/g, x; while ((x = xr.exec(block[1]))) { var id = attrs(x[1]).numFmtId || '0'; dates.push(BUILTIN_DATE[id] === 1 || (fmts[id] !== undefined && isDateCode(fmts[id]))); } }
    return dates;
  }
  function parseSheet(xml, shared, dateStyle) {
    var rows = [], re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, m;
    while ((m = re.exec(xml))) {
      var a = attrs(m[1]), body = m[2] || '', ci = colIndex(a.r || ''), rn = parseInt((/(\d+)$/.exec(a.r || '') || [])[1], 10);
      if (ci < 0 || !rn) continue;
      var t = a.t || 'n', v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body), val = '';
      if (t === 'inlineStr') val = tTexts(body);
      else if (!v) val = '';
      else if (t === 's') val = shared[parseInt(v[1], 10)] || '';
      else if (t === 'str' || t === 'd') val = xmlText(v[1]);
      else if (t === 'b') val = v[1] === '1';
      else if (t === 'e') val = '';
      else { var n = Number(v[1]); val = isFinite(n) ? (dateStyle[parseInt(a.s || '0', 10)] ? { serial: n, date: true } : n) : xmlText(v[1]); }
      var row = rows[rn - 1] || (rows[rn - 1] = []);
      while (row.length < ci) row.push('');
      row[ci] = val;
    }
    for (var i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }
  /** .xlsx bytes -> Promise<{sheets: [{name, rows: [[cell]]}]}>. cell = string | number | boolean | {serial, date:true} | ''. */
  function readWorkbook(u8) {
    if (u8.length > 40 * 1024 * 1024) return Promise.reject(new Error('The file is too large (40 MB maximum).'));
    var ents, dec = new TextDecoder(), get = function (name) { return ents[name] ? entryBytes(u8, ents[name]).then(function (b) { return dec.decode(b); }) : Promise.resolve(''); };
    try { ents = zipEntries(u8); } catch (e) { return Promise.reject(e); }
    return Promise.all([get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'), get('xl/sharedStrings.xml'), get('xl/styles.xml')]).then(function (parts) {
      if (!parts[0]) throw new Error('Not an Excel workbook (xl/workbook.xml is missing).');
      var rels = {}, rr = /<Relationship\b([^>]*?)\/?>/g, m;
      while ((m = rr.exec(parts[1]))) { var ra = attrs(m[1]); rels[ra.Id] = ra.Target || ''; }
      var shared = [], sr = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g;
      while ((m = sr.exec(parts[2]))) shared.push(m[1] ? tTexts(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')) : '');
      var dateStyle = parseStyles(parts[3]), sheets = [], sh = /<sheet\b([^>]*?)\/?>/g;
      while ((m = sh.exec(parts[0]))) { var sa = attrs(m[1]), tg = rels[sa['r:id']] || ''; sheets.push({ name: sa.name, path: tg.charAt(0) === '/' ? tg.slice(1) : 'xl/' + tg.replace(/^\.\//, '') }); }
      return sheets.reduce(function (p, s) {
        return p.then(function (acc) { return get(s.path).then(function (xml) { acc.push({ name: s.name, rows: parseSheet(xml, shared, dateStyle) }); return acc; }); });
      }, Promise.resolve([])).then(function (list) { return { sheets: list }; });
    });
  }

  // ---------------- cell helpers ----------------
  function cellText(c) {
    if (c === null || c === undefined) return '';
    if (typeof c === 'string') return c.trim();
    if (typeof c === 'boolean') return c ? 'TRUE' : 'FALSE';
    if (typeof c === 'number') return String(c);
    if (c.date) { var p = fromSerial(c.serial); return c.serial < 1 ? p.time : p.date; }
    return '';
  }
  /** cell -> 'yyyy-MM-dd HH:mm' | 'yyyy-MM-dd' | 'HH:mm' | '' - for display columns of the file (Effective ..., Work Date). */
  function cellStamp(c) {
    if (c && typeof c === 'object' && c.date) { var p = fromSerial(c.serial); return c.serial < 1 ? p.time : (p.hasTime ? p.date + ' ' + p.time : p.date); }
    return cellText(c);
  }
  /** Parses a New Check-in / Check-out cell -> {kind:'blank'} | {kind:'time', hhmm} | {kind:'datetime', date, hhmm} | {kind:'invalid', why}. */
  function parseNewTime(c) {
    var p, m, s;
    if (c === null || c === undefined || c === '' || (typeof c === 'string' && !c.trim())) return { kind: 'blank' };
    if (typeof c === 'object' && c.date) c = c.serial;
    if (typeof c === 'number') {
      if (!(c >= 0) || c > 2958465) return { kind: 'invalid', why: 'not a valid date-time' };
      p = fromSerial(c);
      return c < 1 ? { kind: 'time', hhmm: p.time } : { kind: 'datetime', date: p.date, hhmm: p.time };
    }
    s = String(c).trim();
    if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s))) {
      if (+m[4] > 23 || +m[5] > 59 || isNaN(dkMs(m[1] + '-' + m[2] + '-' + m[3])) || new Date(dkMs(m[1] + '-' + m[2] + '-' + m[3])).toISOString().slice(0, 10) !== m[1] + '-' + m[2] + '-' + m[3]) return { kind: 'invalid', why: 'not a valid date-time "' + s + '"' };
      return { kind: 'datetime', date: m[1] + '-' + m[2] + '-' + m[3], hhmm: pad2(+m[4]) + ':' + m[5] };
    }
    if ((m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s))) {
      if (+m[1] > 23 || +m[2] > 59) return { kind: 'invalid', why: 'not a valid time "' + s + '"' };
      return { kind: 'time', hhmm: pad2(+m[1]) + ':' + m[2] };
    }
    return { kind: 'invalid', why: 'not a valid date-time or HH:mm: "' + s.slice(0, 30) + '"' };
  }

  // ---------------- reading template rows from the workbook ----------------
  var REQUIRED_HEADERS = ['record id', 'action', 'new check-in', 'new check-out'];
  /** Every sheet whose header row (one of the first 10 rows) has the template headers. Columns are located BY NAME: unknown / extra columns (e.g. 'Hours After Edit') are ignored. */
  function extractRows(wb) {
    var out = [], sheetsUsed = [];
    wb.sheets.forEach(function (sh) {
      var hi = -1, map = null, r, c;
      for (r = 0; r < Math.min(sh.rows.length, 10) && hi < 0; r++) {
        var m = {};
        (sh.rows[r] || []).forEach(function (cell, ci) { var k = cellText(cell).toLowerCase(); if (k && m[k] === undefined) m[k] = ci; });
        if (REQUIRED_HEADERS.every(function (k) { return m[k] !== undefined; })) { hi = r; map = m; }
      }
      if (hi < 0) return;
      sheetsUsed.push(sh.name);
      var g = function (row, k) { return map[k] === undefined ? '' : row[map[k]]; };
      for (r = hi + 1; r < sh.rows.length; r++) {
        var row = sh.rows[r] || [];
        var o = { sheet: sh.name, row: r + 1, recordId: cellText(g(row, 'record id')), code: cellText(g(row, 'employee code')), name: cellText(g(row, 'employee name')),
          workDate: cellStamp(g(row, 'work date')).slice(0, 10), zone: cellText(g(row, 'zone')), event: cellText(g(row, 'event')),
          effIn: normDT(cellStamp(g(row, 'effective check-in'))), effOut: normDT(cellStamp(g(row, 'effective check-out'))),
          rowVersion: cellText(g(row, 'row version')), newInCell: g(row, 'new check-in'), newOutCell: g(row, 'new check-out'),
          newEvent: cellText(g(row, 'new event')), newZone: cellText(g(row, 'new zone')), action: cellText(g(row, 'action')).toUpperCase(), note: cellText(g(row, 'review note')) };
        if (!o.recordId && !o.code && !o.workDate && !o.action) continue;
        out.push(o);
      }
      void c;
    });
    return { rows: out, sheets: sheetsUsed };
  }
  /** Date range (min / max Work Date) of the file rows -> {from, to} | null. */
  function fileRange(rows) {
    var ds = rows.map(function (r) { return r.workDate; }).filter(isDK).sort();
    if (!ds.length) { // fall back on the date inside the Record ID / case key (code|zone|yyyy-mm-dd)
      ds = rows.map(function (r) { var m = /(\d{4}-\d{2}-\d{2})\s*$/.exec(r.recordId); return m ? m[1] : ''; }).filter(Boolean).sort();
    }
    return ds.length ? { from: ds[0], to: ds[ds.length - 1] } : null;
  }
  function splitRange(from, to, max) {
    var out = [], cur = from; max = max || MAX_DAYS;
    while (cur <= to) { var end = addDay(cur, max - 1); if (end > to) end = to; out.push({ from: cur, to: end }); cur = addDay(end, 1); }
    return out;
  }

  // ---------------- classification ----------------
  /** Resolves the New cells against a live record -> {ok, error, checkIn, checkOut (full 'yyyy-MM-dd HH:mm'), inSpec, outSpec}. */
  function resolveTimes(rec, nin, nout) {
    var wd = str(rec.workDate), eff = effOf(rec), orig = origOf(rec), inStr = eff.checkIn, outStr = eff.checkOut, inSpec, outSpec;
    var bad = function (m) { return { ok: false, error: m }; };
    if (nin.kind === 'invalid') return bad('New Check-in ' + nin.why);
    if (nout.kind === 'invalid') return bad('New Check-out ' + nout.why);
    if (nin.kind === 'time') inStr = wd + ' ' + nin.hhmm;
    else if (nin.kind === 'datetime') { if (nin.date !== wd) return bad('New Check-in must be on the Work Date (' + wd + ').'); inStr = nin.date + ' ' + nin.hhmm; }
    if (nout.kind === 'time') { var cand = wd + ' ' + nout.hhmm; outStr = inStr && cand <= inStr ? addDay(wd, 1) + ' ' + nout.hhmm : cand; }
    else if (nout.kind === 'datetime') outStr = nout.date + ' ' + nout.hhmm;
    if (!inStr && !outStr) return bad('Both punches are missing - enter New Check-in and New Check-out.');
    if (!inStr) return bad('Still incomplete: the check-in is missing - enter New Check-in.');
    if (!outStr) return bad('Still incomplete: the check-out is missing - enter New Check-out.');
    var d = (dtMs(outStr) - dtMs(inStr)) / 60000;
    if (!(d > 0)) return bad('Check-out must be after the check-in.');
    if (d > MAX_SPAN_MIN) return bad('Check-out is more than 24 hours after the check-in.');
    // compact specs (KEEP keeps the RECORDED punch; an effective time that differs from it - an earlier correction - is sent explicitly as SET)
    if (nin.kind === 'blank' && inStr === orig.checkIn) inSpec = { mode: 'KEEP' };
    else { if (inStr.slice(0, 10) !== wd) return bad('The check-in must be on the Work Date (' + wd + ').'); inSpec = { mode: 'SET', time: inStr.slice(11) }; }
    if (nout.kind === 'blank' && outStr === orig.checkOut) outSpec = { mode: 'KEEP' };
    else {
      var od = outStr.slice(0, 10);
      if (od !== wd && od !== addDay(wd, 1)) return bad('The check-out must be on the Work Date or the next day.');
      outSpec = { mode: 'SET', time: outStr.slice(11), nextDay: od !== wd };
    }
    return { ok: true, checkIn: inStr, checkOut: outStr, inSpec: inSpec, outSpec: outSpec };
  }
  /**
   * rows (extractRows) x live records (prepared svList records) -> {rows: [{...row, status, message, rec, resolved, item}], counts}.
   * status: APPLY | UNCHANGED | ALREADY_APPLIED | INVALID | REQUIRES_APPROVAL | CONFLICT | REFUSED | ERROR
   */
  function classify(rows, records, opts) {
    opts = opts || {};
    var byId = {}, byKey = {}, byCase = {};
    records.forEach(function (r) {
      if (r.recordId) byId[str(r.recordId).trim()] = r;
      if (r.caseKey) byCase[str(r.caseKey).trim()] = r;
      byKey[str(r.workDate) + '|' + str(r.zone).trim() + '|' + str(r.employeeCode).trim()] = r;
    });
    var seen = {};
    var located = rows.map(function (row) {
      var rec = null, key;
      if (row.recordId) { rec = byId[row.recordId] || byCase[row.recordId] || null; key = row.recordId; }
      else { key = row.workDate + '|' + row.zone + '|' + row.code; rec = byKey[key] || null; }
      var ident = rec ? 'rec:' + (rec.caseKey || rec.recordId) : 'raw:' + key;
      seen[ident] = (seen[ident] || 0) + 1;
      return { row: row, rec: rec, ident: ident, key: key };
    });
    var out = located.map(function (L) {
      var row = L.row, rec = L.rec, res = Object.assign({}, row, { rec: rec, status: '', message: '', resolved: null });
      var fin = function (st, msg) { res.status = st; res.message = msg || ''; return res; };
      if (!row.recordId && !(row.workDate && row.zone && row.code)) return fin('ERROR', 'No Record ID (and no Work Date + Zone + Employee Code) on this row.');
      if (seen[L.ident] > 1) return fin('ERROR', 'Duplicate record in the file (' + seen[L.ident] + ' rows with the same key) - every duplicate is refused.');
      if (!rec) return fin('ERROR', 'Unknown record: it is not in the current attendance data for these dates.');
      if (row.action !== 'APPLY') {
        if (row.action && row.action !== 'NO_CHANGE') return fin('INVALID', 'Action must be APPLY or NO_CHANGE (found "' + row.action + '").');
        var filled = row.newInCell !== '' && row.newInCell !== undefined && row.newInCell !== null || row.newOutCell !== '' && row.newOutCell !== undefined && row.newOutCell !== null || row.newEvent || row.newZone;
        return fin('UNCHANGED', filled ? 'Ignored: Action is not APPLY (the New values were not used).' : '');
      }
      var eff = effOf(rec), orig = origOf(rec);
      if (!orig.checkIn && !orig.checkOut && !eff.checkIn && !eff.checkOut) return fin('REFUSED', 'No real punch for this day - it cannot become attendance.');
      if (rec.final) return fin('REFUSED', 'FINAL zone-day: read-only.');
      if (rec.canEdit === false) return fin('REFUSED', 'Not editable (' + (rec.readOnlyReason || 'no access') + ').');
      if (row.newEvent || row.newZone) return fin('REQUIRES_APPROVAL', 'Zone / Event reassignment needs the Zone Manager - not applied by the import.');
      var rv = resolveTimes(rec, parseNewTime(row.newInCell), parseNewTime(row.newOutCell));
      if (!rv.ok) return fin('INVALID', rv.error);
      res.resolved = rv;
      if (rv.checkIn === eff.checkIn && rv.checkOut === eff.checkOut) return fin('ALREADY_APPLIED', 'These times are already the effective times.');
      if (!row.rowVersion) return fin('INVALID', 'Row Version is missing - export the template again.');
      var offline = /^\d+\|offline$/i.test(row.rowVersion);
      if (offline) { if (row.effIn !== eff.checkIn || row.effOut !== eff.checkOut) return fin('CONFLICT', 'The record changed since the file was made (effective ' + (row.effIn || '-') + ' / ' + (row.effOut || '-') + ' is now ' + (eff.checkIn || '-') + ' / ' + (eff.checkOut || '-') + ').'); }
      else if (row.rowVersion !== rec.rowVersion) return fin('CONFLICT', 'The record changed since the file was exported (Row Version ' + row.rowVersion + ', now ' + rec.rowVersion + ').');
      return fin('APPLY', '');
    });
    var counts = { total: out.length, apply: 0, unchanged: 0, alreadyApplied: 0, invalid: 0, requiresApproval: 0, conflict: 0, refused: 0, error: 0 };
    var KEY = { APPLY: 'apply', UNCHANGED: 'unchanged', ALREADY_APPLIED: 'alreadyApplied', INVALID: 'invalid', REQUIRES_APPROVAL: 'requiresApproval', CONFLICT: 'conflict', REFUSED: 'refused', ERROR: 'error' };
    out.forEach(function (r) { counts[KEY[r.status]]++; });
    return { rows: out, counts: counts };
  }
  /** Adds the deterministic request id "IMP-" + sha12(recordId|newIn|newOut) to every APPLY row (same file twice -> same ids). */
  function assignRequestIds(rows) {
    var ap = rows.filter(function (r) { return r.status === 'APPLY'; });
    return Promise.all(ap.map(function (r) { return sha12(str(r.rec.recordId || r.rec.caseKey) + '|' + r.resolved.checkIn + '|' + r.resolved.checkOut); })).then(function (hs) {
      ap.forEach(function (r, i) { r.requestId = 'IMP-' + hs[i]; });
      return rows;
    });
  }
  function reasonFor(fileName) { return 'Bulk Excel import ' + str(fileName).replace(/[\u0000-\u001F]/g, ' ').slice(0, 60); }
  /** APPLY rows -> svCorrectBatch items (verbose shape, before compact encoding). */
  function buildItems(rows, fileName) {
    var reason = reasonFor(fileName);
    return rows.filter(function (r) { return r.status === 'APPLY'; }).map(function (r) {
      return { caseKey: r.rec.caseKey, workDate: r.rec.workDate, expectedVersion: Number(r.rec.version) || 0, stampHash: r.rec.stampHash, requestId: r.requestId, action: 'CORRECT',
        checkIn: r.resolved.inSpec, checkOut: r.resolved.outSpec, reason: reason, evidence: reason, directApproval: true, _row: r };
    });
  }

  // ---------------- compact encoding + packing (mirror of supervisor.js compactArgs / packRequests and Supervisor.js svDecodeCompact_) ----------------
  function validHHmm(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v || ''); }
  function specCode(sp) {
    if (!sp || sp.mode === 'KEEP') return '';
    if (sp.mode === 'SCHEDULE') return 'S';
    if (sp.mode === 'SET' && validHHmm(sp.time)) return sp.time + (sp.nextDay === true ? '+' : '');
    return null;
  }
  /** {r: string table, c: [[caseKey, version, stampHash, requestId, action(0 CORRECT|1 CONFIRM), inSpec, outSpec, reasonIdx, evidenceIdx, direct]]} merged into base. null when an item cannot be encoded. */
  function compactArgs(base, items) {
    var r = [], at = {}, c = [], ok = true;
    var idx = function (t) { if (t === undefined || t === null || t === '') return -1; t = String(t); if (at[t] === undefined) { at[t] = r.length; r.push(t); } return at[t]; };
    items.forEach(function (it) {
      var a = it.action === 'CONFIRM' ? 1 : it.action === 'CORRECT' ? 0 : -1, ci = specCode(it.checkIn), co = specCode(it.checkOut), h = it.stampHash;
      if (a < 0 || ci === null || co === null || !/^[0-9a-f]{12}$/.test(h || '')) { ok = false; return; }
      c.push([it.caseKey, it.expectedVersion, h, it.requestId, a, ci, co, idx(it.reason), idx(it.evidence), it.directApproval === true ? 1 : 0]);
    });
    if (!ok) return null;
    var out = Object.assign({}, base); out.r = r; out.c = c; return out;
  }
  function utf8len(s) { return new TextEncoder().encode(s).length; }
  /** The exact POST body A.call sends (HMGAccess.call: action / token key follow the credential kind). cred = {kind, value}. */
  function bodyBytes(name, args, from, to, cred) {
    var b = { action: cred && cred.kind === 'device' ? 'periodAnalyticsViaDevice' : 'periodAnalytics', op: name, date: from, fromDate: from, toDate: to, opArgs: JSON.stringify(args || {}) };
    b[cred && cred.kind === 'device' ? 'deviceToken' : 'adminToken'] = cred ? cred.value : '';
    return utf8len(JSON.stringify(b));
  }
  /**
   * items (buildItems) -> {plan: [{items, args, from, to}], tooLong: [item]}. Date-ordered; a request is closed at 25 items, at a window above 31 days
   * (day gap > 30) or when the encoded body would exceed 3,800 bytes. opts: {cred, batchId: fn(n) -> id (<= 34 chars), max, budget}.
   */
  function packBatches(items, opts) {
    opts = opts || {};
    var cred = opts.cred || { kind: 'admin', value: new Array(201).join('x') }, max = opts.max || BATCH_MAX, budget = opts.budget || BODY_BUDGET, mkId = opts.batchId || function (n) { return 'IMPB-' + n; };
    var sorted = items.slice().sort(function (a, b) { return a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : (a.caseKey < b.caseKey ? -1 : 1); });
    var plan = [], tooLong = [], cur = [], first = '';
    var build = function (es, id) {
      var ds = es.map(function (e) { return e.workDate; }).sort(), args = compactArgs({ batchId: id, confirm: true, adminOverride: true }, es);
      return { args: args, from: ds[0], to: ds[ds.length - 1] };
    };
    var size = function (es) { var b = build(es, BATCH_ID_PLACEHOLDER); return b.args ? bodyBytes('svCorrectBatch', b.args, b.from, b.to, cred) : Infinity; };
    var flush = function () { if (!cur.length) return; var b = build(cur, mkId(plan.length + 1)); plan.push({ items: cur, args: b.args, from: b.from, to: b.to }); cur = []; };
    sorted.forEach(function (e) {
      if (size([e]) > budget) { tooLong.push(e); return; }
      if (cur.length && (cur.length >= max || dayGap(first, e.workDate) > MAX_DAYS - 1 || size(cur.concat([e])) > budget)) flush();
      if (!cur.length) first = e.workDate;
      cur.push(e);
    });
    flush();
    return { plan: plan, tooLong: tooLong };
  }

  // ---------------- result workbook ----------------
  var RESULT_HEADERS = ['Sheet', 'Row', 'Record ID', 'Employee Code', 'Employee Name', 'Work Date', 'Zone', 'Event', 'New Check-in', 'New Check-out', 'Outcome', 'Message'];
  /** Maps a classified / applied row to its outcome label. */
  function outcomeOf(r) { return r.outcome || (r.status === 'UNCHANGED' ? 'UNCHANGED' : r.status); }
  function resultSheets(rows, meta) {
    meta = meta || {};
    var cols = RESULT_HEADERS.map(function (h, i) { return { header: h, type: i === 2 || i === 3 ? 'string' : i === 5 ? 'date' : i === 8 || i === 9 ? 'datetime' : i === 1 ? 'number' : 'text', width: [14, 7, 34, 14, 26, 12, 18, 26, 18, 18, 20, 70][i] }; });
    var data = rows.map(function (r) {
      var rs = r.resolved || {};
      return [r.sheet, r.row, r.recordId, r.code, r.name, r.workDate, r.zone, r.event, rs.checkIn || '', rs.checkOut || '', outcomeOf(r), r.outMessage !== undefined ? r.outMessage : r.message];
    });
    var tally = {}; rows.forEach(function (r) { var o = outcomeOf(r); tally[o] = (tally[o] || 0) + 1; });
    var sum = Object.keys(tally).sort().map(function (k) { return [k, tally[k]]; });
    sum.push([{ v: 'File', style: 'bold' }, str(meta.fileName)]); sum.push([{ v: 'Processed', style: 'bold' }, str(meta.at)]);
    return [{ name: 'Summary', columns: [{ header: 'Outcome', width: 24 }, { header: 'Rows', type: 'text', width: 40 }], rows: sum }, { name: 'Results', columns: cols, rows: data }];
  }

  var api = { COLUMNS: COLUMNS, COL_TYPES: COL_TYPES, EDIT_COLS: EDIT_COLS, BODY_BUDGET: BODY_BUDGET, BATCH_MAX: BATCH_MAX, sha12: sha12, prepareRecords: prepareRecords, templateRow: templateRow, crossZoneKeys: crossZoneKeys,
    buildTemplate: buildTemplate, readWorkbook: readWorkbook, extractRows: extractRows, fileRange: fileRange, splitRange: splitRange, parseNewTime: parseNewTime, resolveTimes: resolveTimes, classify: classify,
    assignRequestIds: assignRequestIds, buildItems: buildItems, compactArgs: compactArgs, bodyBytes: bodyBytes, packBatches: packBatches, resultSheets: resultSheets, outcomeOf: outcomeOf, reasonFor: reasonFor,
    cellText: cellText, cellStamp: cellStamp, normDT: normDT, fromSerial: fromSerial, addDay: addDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HMGBulk = api;
  if (typeof document !== 'undefined' && document.getElementById('baHost') && root.HMGAccess && root.HMGXlsxPro) initUI();

  // ================= browser UI =================
  function initUI() {
    var A = root.HMGAccess, X = root.HMGXlsxPro, $ = function (id) { return document.getElementById(id); };
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
    function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
    function field(label, input) { var f = el('div', 'filter-field'), l = el('label', null, label); f.appendChild(l); f.appendChild(input); return f; }
    function btn(text, cls, fn) { var b = el('button', cls || 'btn-secondary', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
    function msg(node, text, err) { node.textContent = text || ''; node.className = err ? 'meta report-error' : 'meta'; }
    var host = $('baHost'), RETRY_MS = 2000, PAGE = 1000;
    function call(op, args, from, to) { return A.call({ action: 'periodAnalytics', op: op, date: from, fromDate: from, toDate: to, opArgs: JSON.stringify(args || {}) }, 120000); }
    function callWrite(op, args, from, to, onBusy) {
      var n = 0;
      function go() {
        return call(op, args, from, to).then(function (r) {
          if (r && r.retryable === true && n < 3) { n++; if (onBusy) onBusy(n); return new Promise(function (res) { setTimeout(res, RETRY_MS * n); }).then(go); }
          return r;
        });
      }
      return go();
    }
    /** svList paging (copy of supervisor.js fetchAll): listId pages, signature / total consistency, up to 3 attempts. */
    function fetchRange(a, progress) {
      function attempt(n) {
        var got = [], first = null, listId = '';
        function page(offset) {
          var args = Object.assign({}, a, { offset: offset, limit: PAGE });
          if (listId && offset > 0) args.listId = listId;
          return call('svList', args, a.from, a.to).then(function (r) {
            if (!r || !r.ok) return { fail: (r && (r.error || r.code)) || 'no answer' };
            if (!first) { first = r; listId = r.listId || ''; } else if (r.recomputed === true || r.signature !== first.signature || r.total !== first.total) return { retry: true };
            var rs = r.rows || []; for (var i = 0; i < rs.length; i++) got.push(rs[i]);
            if (progress) progress(Math.min(offset + rs.length, r.total), r.total);
            if (offset + rs.length >= r.total) return {};
            if (!rs.length) return { retry: true };
            return page(offset + rs.length);
          });
        }
        return page(0).then(function (s) {
          if (s.fail) return { ok: false, error: s.fail };
          var seen = {}, dup = 0;
          if (!s.retry) got.forEach(function (c) { if (seen[c.caseKey]) dup++; seen[c.caseKey] = 1; });
          if (s.retry || got.length !== first.total || dup) { if (n < 3) return attempt(n + 1); return { ok: false, error: 'The list changed while it was loading (3 attempts) - nothing was used. Try again.' }; }
          return { ok: true, rows: got };
        });
      }
      return attempt(1);
    }
    /** Several 31-day windows -> one de-duplicated record list. */
    function fetchWindows(from, to, zone, note) {
      var wins = splitRange(from, to, MAX_DAYS), all = [], seen = {};
      return wins.reduce(function (p, w, i) {
        return p.then(function (res) {
          if (!res.ok) return res;
          var a = { from: w.from, to: w.to, view: 'ALL', status: 'ALL' }; if (zone) a.zone = zone;
          return fetchRange(a, function (n, t) { note('Window ' + (i + 1) + ' of ' + wins.length + ': ' + n + ' / ' + t + '…'); }).then(function (r) {
            if (!r.ok) return r;
            r.rows.forEach(function (c) { if (!seen[c.caseKey]) { seen[c.caseKey] = 1; all.push(c); } });
            return { ok: true, rows: all };
          });
        });
      }, Promise.resolve({ ok: true, rows: all }));
    }
    function download(name, u8) {
      var url = URL.createObjectURL(new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 4000);
    }
    function stamp() { var d = new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()); }
    function tableOf(headers, rows) {
      var w = el('div', 'table-scroll'), t = el('table', 'data-table'), th = el('thead'), hr = el('tr'), tb = el('tbody');
      headers.forEach(function (h) { hr.appendChild(el('th', null, h)); }); th.appendChild(hr); t.appendChild(th);
      rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (v) { var td = el('td', null, v === '' || v === null || v === undefined ? '—' : v); td.setAttribute('dir', 'auto'); tr.appendChild(td); }); tb.appendChild(tr); });
      t.appendChild(tb); w.appendChild(t); return w;
    }

    // ---------- export ----------
    var exBox = el('div', 'zo-sub'); exBox.appendChild(el('div', 'group-title', 'Export All Attendance (editable) / تصدير كل الحضور (قابل للتعديل)'));
    exBox.appendChild(el('div', 'meta', 'One workbook: Instructions, Summary, a sheet per zone and Review_Special. Only the yellow cells are editable (New Check-in / New Check-out / New Event / New Zone / Action). Reads the live attendance of every zone in at most 31-day windows. Nothing is changed by exporting.'));
    var exFrom = el('input'), exTo = el('input'), exZone = el('input'), exStatus = el('div', 'meta'), exBtn;
    exFrom.type = 'date'; exTo.type = 'date'; exZone.type = 'text'; exZone.maxLength = 60; exZone.placeholder = 'all zones';
    exFrom.value = A.todayRiyadh(); exTo.value = A.todayRiyadh();
    var exBar = el('div', 'filter-bar'); exBar.appendChild(field('From', exFrom)); exBar.appendChild(field('To', exTo)); exBar.appendChild(field('Zone (optional)', exZone));
    var exBusy = false;
    exBtn = btn('Export All Attendance (editable)', 'btn-primary', function () {
      if (exBusy) return;
      var from = exFrom.value, to = exTo.value;
      if (!isDK(from) || !isDK(to) || from > to) { msg(exStatus, 'Choose a valid date range.', true); return; }
      if (dayGap(from, to) > 365) { msg(exStatus, 'At most 366 days per export.', true); return; }
      exBusy = true; exBtn.disabled = true; msg(exStatus, 'Loading…');
      fetchWindows(from, to, exZone.value.trim(), function (t) { msg(exStatus, t); }).then(function (r) {
        if (!r.ok) throw new Error(r.error);
        msg(exStatus, 'Preparing ' + r.rows.length + ' records…');
        return prepareRecords(r.rows);
      }).then(function (recs) {
        var t = buildTemplate(recs, { from: from, to: to, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' });
        var u8 = X.build(t.sheets), name = 'HMG_All_Attendance_' + from + '_' + to + '_Editable_' + stamp() + '.xlsx';
        download(name, u8);
        msg(exStatus, 'Downloaded ' + name + ' - ' + t.counts.total + ' records (' + Object.keys(t.counts.zones).length + ' zone sheets, ' + t.counts.special + ' in Review_Special).');
      }).then(null, function (e) { msg(exStatus, 'Export failed: ' + (e && e.message || e), true); }).then(function () { exBusy = false; exBtn.disabled = false; });
    });
    var exAct = el('div', 'filter-field'); exAct.appendChild(exBtn); exBar.appendChild(exAct);
    exBox.appendChild(exBar); exBox.appendChild(exStatus); host.appendChild(exBox);

    // ---------- import ----------
    var imBox = el('div', 'zo-sub'); imBox.appendChild(el('div', 'group-title', 'Import Attendance Corrections / استيراد التصحيحات'));
    imBox.appendChild(el('div', 'meta', 'Upload the edited workbook (.xlsx). The file is read in this browser, checked against the CURRENT attendance, and shown as a preview. Nothing is saved until you press Apply. Only rows with Action = APPLY are used; Zone / Event reassignments are never applied here.'));
    var file = el('input'); file.type = 'file'; file.accept = '.xlsx';
    var imStatus = el('div', 'meta'), imCounts = el('div', 'meta'), imTable = el('div'), imResult = el('div', 'meta'), state = null, busy = false;
    var prevBtn = btn('Preview', 'btn-primary', preview), applyBtn = btn('Apply', 'btn-primary', apply), dlBtn = btn('Download result workbook', 'btn-secondary', function () { if (state && state.resultRows) download('HMG_Import_Result_' + stamp() + '.xlsx', X.build(resultSheets(state.resultRows, { fileName: state.fileName, at: new Date().toISOString() }))); });
    applyBtn.disabled = true; applyBtn.hidden = true; dlBtn.hidden = true;
    var imBar = el('div', 'filter-bar'); imBar.appendChild(field('Edited workbook (.xlsx)', file));
    [prevBtn, applyBtn, dlBtn].forEach(function (b) { var f = el('div', 'filter-field'); f.appendChild(b); imBar.appendChild(f); });
    file.addEventListener('change', function () { state = null; applyBtn.disabled = true; applyBtn.hidden = true; dlBtn.hidden = true; clear(imTable); imCounts.textContent = ''; imResult.textContent = ''; msg(imStatus, ''); });
    imBox.appendChild(imBar); [imStatus, imCounts, imTable, imResult].forEach(function (n) { imBox.appendChild(n); }); host.appendChild(imBox);

    function renderPreview() {
      var c = state.cls.counts;
      imCounts.textContent = 'Rows ' + c.total + ' · Apply ' + c.apply + ' · Unchanged ' + c.unchanged + ' · Already applied ' + c.alreadyApplied + ' · Invalid ' + c.invalid + ' · Requires approval ' + c.requiresApproval + ' · Conflict ' + c.conflict + ' · Refused ' + c.refused + ' · Errors ' + c.error;
      clear(imTable);
      var shown = state.cls.rows.filter(function (r) { return r.status !== 'UNCHANGED' || r.message; });
      var rows = shown.slice(0, 500).map(function (r) { return [r.status, r.sheet, r.row, r.code, r.name, r.workDate, r.zone, r.resolved ? r.resolved.checkIn : '', r.resolved ? r.resolved.checkOut : '', r.message]; });
      imTable.appendChild(tableOf(['Status', 'Sheet', 'Row', 'Code', 'Name', 'Work Date', 'Zone', 'New Check-in', 'New Check-out', 'Message'], rows));
      if (shown.length > 500) imTable.appendChild(el('div', 'meta', 'Showing the first 500 of ' + shown.length + ' rows - all of them are in the result workbook.'));
    }
    function preview() {
      if (busy) return;
      var f = file.files && file.files[0];
      if (!f) { msg(imStatus, 'Choose the edited .xlsx first.', true); return; }
      busy = true; prevBtn.disabled = true; applyBtn.disabled = true; msg(imStatus, 'Reading the workbook…'); state = null; clear(imTable); imCounts.textContent = ''; imResult.textContent = ''; dlBtn.hidden = true;
      f.arrayBuffer().then(function (ab) { return readWorkbook(new Uint8Array(ab)); }).then(function (wb) {
        var ex = extractRows(wb);
        if (!ex.rows.length) throw new Error('No template rows found (no sheet has the Record ID / Action / New Check-in / New Check-out header).');
        var rg = fileRange(ex.rows);
        if (!rg) throw new Error('No valid Work Date in the file.');
        if (dayGap(rg.from, rg.to) > 365) throw new Error('The file spans more than 366 days.');
        msg(imStatus, 'Loading the current attendance ' + rg.from + ' → ' + rg.to + '…');
        return fetchWindows(rg.from, rg.to, '', function (t) { msg(imStatus, t); }).then(function (r) {
          if (!r.ok) throw new Error(r.error);
          return prepareRecords(r.rows);
        }).then(function (recs) {
          var cls = classify(ex.rows, recs); return assignRequestIds(cls.rows).then(function () { state = { cls: cls, fileName: f.name, sheets: ex.sheets }; });
        });
      }).then(function () {
        renderPreview();
        var c = state.cls.counts;
        msg(imStatus, 'Preview ready (' + state.sheets.length + ' sheets read). ' + (c.apply ? 'Press "Apply ' + c.apply + ' corrections" to save them.' : 'Nothing to apply.'));
        applyBtn.textContent = 'Apply ' + c.apply + ' corrections'; applyBtn.hidden = false; applyBtn.disabled = c.apply === 0;
        state.resultRows = state.cls.rows; dlBtn.hidden = false;
      }).then(null, function (e) { msg(imStatus, 'Preview failed: ' + (e && e.message || e), true); }).then(function () { busy = false; prevBtn.disabled = false; });
    }
    function apply() {
      if (busy || !state || !state.cls.counts.apply) return;
      var items = buildItems(state.cls.rows, state.fileName), pk = packBatches(items, { cred: A.credential(), batchId: function () { var b = new Uint8Array(6); crypto.getRandomValues(b); return 'IMPB-' + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); } });
      if (!window.confirm('Apply ' + items.length + ' corrections as administrator (direct approval)?')) return;
      busy = true; applyBtn.disabled = true; prevBtn.disabled = true; var done = 0, stopped = false;
      pk.tooLong.forEach(function (it) { it._row.outcome = 'FAILED'; it._row.outMessage = 'Too large for one request.'; });
      function finish() {
        busy = false; prevBtn.disabled = false; state.resultRows = state.cls.rows; dlBtn.hidden = false;
        var t = {}; state.cls.rows.forEach(function (r) { if (r.outcome) t[r.outcome] = (t[r.outcome] || 0) + 1; });
        msg(imResult, 'Done: ' + Object.keys(t).sort().map(function (k) { return k + ' ' + t[k]; }).join(' · ') + (stopped ? ' · STOPPED - re-upload the same file to continue (safe: saved rows are recognised).' : ''), stopped);
      }
      function run(i) {
        if (i >= pk.plan.length) { finish(); return; }
        var p = pk.plan[i];
        msg(imResult, 'Saving ' + (done + p.items.length) + ' / ' + items.length + '…');
        callWrite('svCorrectBatch', p.args, p.from, p.to, function (n) { msg(imResult, 'Busy - retrying… (' + n + ' of 3)'); }).then(function (r) {
          if (!r || r.ok === false) {
            var net = !r || (!r.code && !r.retryable && /^(Network error|Empty response|timed out)/i.test(String(r.error || '')));
            p.items.forEach(function (it) { it._row.outcome = 'FAILED'; it._row.outMessage = (net ? 'Not confirmed - re-upload the same file (safe). ' : 'Not saved: ') + str(r && (r.error || r.code)); });
            stopped = true; finish(); return;
          }
          var by = {}; (r.results || []).forEach(function (x) { if (x && x.caseKey) by[x.caseKey] = x; });
          p.items.forEach(function (it) {
            var x = by[it.caseKey], row = it._row;
            if (!x) { row.outcome = 'FAILED'; row.outMessage = 'No answer for this record - re-upload the same file (safe).'; return; }
            if (x.status === 'SAVED') {
              if (x.duplicate) { row.outcome = 'ALREADY_APPLIED'; row.outMessage = 'Already saved by an earlier upload of this file.'; }
              else if (r.verified !== true) { row.outcome = 'FAILED'; row.outMessage = 'Saved but the batch was not verified - re-upload the same file (safe).'; }
              else { row.outcome = 'SAVED'; row.outMessage = 'Saved (correction version ' + (x.version === undefined || x.version === null ? '' : x.version) + ').'; }
            } else if (x.status === 'CONFLICT') { row.outcome = 'CONFLICT'; row.outMessage = (x.error || x.code || 'Record changed') + ' [' + (x.code || '') + ']'; }
            else if (x.status === 'REQUIRES_REVIEW') { row.outcome = 'REQUIRES_APPROVAL'; row.outMessage = (x.error || x.code || 'Needs review') + ' [' + (x.code || '') + ']'; }
            else { row.outcome = 'FAILED'; row.outMessage = (x.error || x.code || 'failed') + ' [' + (x.code || '') + ']'; }
          });
          done += p.items.length; run(i + 1);
        }, function (e) { p.items.forEach(function (it) { it._row.outcome = 'FAILED'; it._row.outMessage = 'Not confirmed - re-upload the same file (safe). ' + (e && e.message || ''); }); stopped = true; finish(); });
      }
      run(0);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
