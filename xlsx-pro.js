// Richer dependency-free .xlsx writer (V1.5, 2026-11-17) - HMGXlsxPro. xlsx.js is NOT changed (other pages use it).
// Adds what the editable attendance template needs: named cell styles (fills, bold, wrap, number formats), UNLOCKED yellow
// edit cells, sheet protection WITHOUT a password (accidental-edit guard only), list data validation, frozen header, auto-filter,
// tab colours, real Excel date / date-time / duration values and text-typed code cells. Stored (uncompressed) ZIP, inline strings.
// Shared later by the offline Python file layout (same sheet / style vocabulary).
//
// HMGXlsxPro.build(sheets) -> Uint8Array
//   sheet = { name, columns: [{ header, type, width, edit }], rows: [[...]], header (default true), protect (bool),
//             validations: [{ col (0-based), list: ['A','B'], title, error, prompt }], tabColor: 'FF1A1A1A', autoFilter (default true), widths }
//   column.type: 'text' (numbers stay numbers) | 'string' (always text: codes, ids) | 'number' | 'wrap' | 'date' | 'datetime' | 'newtime' | 'duration'
//     'newtime' = date-time shown as hh:mm when the value is a bare time (< 1) else yyyy-mm-dd hh:mm; used by the editable New Check-in / out cells
//     'duration' accepts a number of MINUTES and stores it as an Excel duration shown [h]:mm
//   column.edit = true -> unlocked + yellow fill (the only cells a protected sheet lets the user change)
//   a cell may also be { v, style } with style 'title' | 'note' | 'bold' | 'head' (Instructions / Summary sheets)
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function zip(files) {
    var parts = [], central = [], offset = 0;
    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    files.forEach(function (f) {
      var name = utf8(f.name), crc = crc32(f.data), size = f.data.length;
      var local = [].concat([0x50, 0x4B, 0x03, 0x04], u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0));
      parts.push(new Uint8Array(local), name, f.data);
      central.push(new Uint8Array([].concat([0x50, 0x4B, 0x01, 0x02], u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += local.length + name.length + size;
    });
    var centralSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4B, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)));
    var all = parts.concat(central, [end]), total = all.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }
  function esc(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  // ---- wall-clock -> Excel serial (no time-zone shift; 25569 = 1970-01-01) ----
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  var TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  function serial(v, type) {
    var s = String(v).trim(), m;
    if (type === 'newtime' && (m = TIME_RE.exec(s))) return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0)) / 86400;
    if ((m = DATE_RE.exec(s))) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)) / 86400000 + 25569;
    return null;
  }

  // ---- style book: every distinct (format, fill, font, wrap, locked) is one cellXfs entry, registered on demand ----
  var FMT = { general: 0, text: 49, date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm', newtime: '[<1]hh:mm;yyyy-mm-dd hh:mm', duration: '[h]:mm' };
  var FILLS = { none: null, head: 'FF1A1A1A', headEdit: 'FFFFD966', edit: 'FFFFF2CC', note: 'FFF2F2F2', title: 'FFDDEBF7' };
  function StyleBook() { this.fmts = []; this.fills = ['none', 'gray125']; this.fonts = ['n', 'b', 'bw', 'bt']; this.xfs = []; this.index = {}; this.get({}); }
  StyleBook.prototype.fmtId = function (f) {
    if (typeof f === 'number') return f;
    var i = this.fmts.indexOf(f); if (i === -1) { this.fmts.push(f); i = this.fmts.length - 1; }
    return 164 + i;
  };
  StyleBook.prototype.fillId = function (name) {
    if (!name || name === 'none') return 0;
    var i = this.fills.indexOf(name); if (i === -1) { this.fills.push(name); i = this.fills.length - 1; }
    return i;
  };
  /** st = { fmt (FMT value), fill, font ('n'|'b'|'bw'|'bt'), wrap, locked (default true), top } -> xf index */
  StyleBook.prototype.get = function (st) {
    var key = [st.fmt === undefined ? 0 : st.fmt, st.fill || '', st.font || 'n', st.wrap ? 1 : 0, st.locked === false ? 0 : 1].join('~');
    if (this.index[key] !== undefined) return this.index[key];
    var xf = { fmt: this.fmtId(st.fmt === undefined ? 0 : st.fmt), fill: this.fillId(st.fill), font: this.fonts.indexOf(st.font || 'n'), wrap: !!st.wrap, locked: st.locked !== false };
    this.xfs.push(xf); this.index[key] = this.xfs.length - 1;
    return this.index[key];
  };
  StyleBook.prototype.xml = function () {
    var self = this;
    var fontXml = { n: '<font><sz val="11"/><name val="Calibri"/></font>', b: '<font><b/><sz val="11"/><name val="Calibri"/></font>',
      bw: '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>', bt: '<font><b/><sz val="14"/><name val="Calibri"/></font>' };
    var fillXml = this.fills.map(function (f) {
      if (f === 'none') return '<fill><patternFill patternType="none"/></fill>';
      if (f === 'gray125') return '<fill><patternFill patternType="gray125"/></fill>';
      return '<fill><patternFill patternType="solid"><fgColor rgb="' + FILLS[f] + '"/><bgColor indexed="64"/></patternFill></fill>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (this.fmts.length ? '<numFmts count="' + this.fmts.length + '">' + this.fmts.map(function (f, i) { return '<numFmt numFmtId="' + (164 + i) + '" formatCode="' + esc(f) + '"/>'; }).join('') + '</numFmts>' : '') +
      '<fonts count="' + this.fonts.length + '">' + this.fonts.map(function (f) { return fontXml[f]; }).join('') + '</fonts>' +
      '<fills count="' + this.fills.length + '">' + fillXml + '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + this.xfs.length + '">' + this.xfs.map(function (x) {
        var al = x.wrap ? '<alignment wrapText="1" vertical="top"/>' : '', pr = x.locked ? '' : '<protection locked="0"/>';
        return '<xf numFmtId="' + x.fmt + '" fontId="' + x.font + '" fillId="' + x.fill + '" borderId="0" xfId="0"' + (x.fmt ? ' applyNumberFormat="1"' : '') + (x.font ? ' applyFont="1"' : '') + (x.fill ? ' applyFill="1"' : '') +
          (al ? ' applyAlignment="1"' : '') + (pr ? ' applyProtection="1"' : '') + (al || pr ? '>' + al + pr + '</xf>' : '/>');
      }).join('') + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    void self;
  };

  var NAMED = { title: { font: 'bt', fill: 'title' }, note: { wrap: true, fill: 'note' }, bold: { font: 'b' }, head: { font: 'bw', fill: 'head' } };
  function colStyle(col) {
    var t = col.type || 'text', ed = !!col.edit, st = { locked: !ed, fill: ed ? 'edit' : undefined };
    if (t === 'date') st.fmt = FMT.date; else if (t === 'datetime') st.fmt = FMT.datetime; else if (t === 'newtime') st.fmt = FMT.newtime; else if (t === 'duration') st.fmt = FMT.duration;
    else if (t === 'string' || (ed && t === 'text')) st.fmt = FMT.text;
    if (t === 'wrap') st.wrap = true;
    return st;
  }
  function cellXml(book, ref, v, col) {
    var named = null;
    if (v && typeof v === 'object' && !(v instanceof Date)) { named = NAMED[v.style] || null; v = v.v; }
    var t = col.type || 'text', base = named ? Object.assign({ locked: true }, named) : colStyle(col), s = book.get(base), empty = v === null || v === undefined || v === '';
    if (empty) return s ? '<c r="' + ref + '" s="' + s + '"/>' : '';
    if (!named && (t === 'date' || t === 'datetime' || t === 'newtime')) {
      var n = serial(v, t);
      if (n !== null) return '<c r="' + ref + '" s="' + s + '"><v>' + n + '</v></c>';
    }
    if (!named && t === 'duration' && isFinite(Number(v))) return '<c r="' + ref + '" s="' + s + '"><v>' + (Number(v) / 1440) + '</v></c>';
    if (!named && t !== 'string' && (t === 'number' || typeof v === 'number') && isFinite(Number(v))) return '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + '><v>' + Number(v) + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"' + (s ? ' s="' + s + '"' : '') + '><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sh, book) {
    var cols = sh.columns, rows = sh.rows || [], header = sh.header !== false;
    var lastCol = colName(Math.max(cols.length, 1) - 1), lastRow = rows.length + (header ? 1 : 0);
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
    if (sh.tabColor) out.push('<sheetPr><tabColor rgb="' + sh.tabColor + '"/></sheetPr>');
    out.push('<sheetViews><sheetView workbookViewId="0"' + (sh.index === 0 ? ' tabSelected="1"' : '') + '>' + (header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews>');
    out.push('<sheetFormatPr defaultRowHeight="15"/>');
    out.push('<cols>' + cols.map(function (c, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || Math.min(Math.max(String(c.header || '').length + 4, 10), 40)) + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>');
    var r = 1;
    if (header) {
      var hs = {}; out.push('<row r="1">' + cols.map(function (c, i) {
        hs = { font: c.edit ? 'b' : 'bw', fill: c.edit ? 'headEdit' : 'head', locked: true };
        return '<c r="' + colName(i) + '1" t="inlineStr" s="' + book.get(hs) + '"><is><t xml:space="preserve">' + esc(c.header) + '</t></is></c>';
      }).join('') + '</row>');
      r = 2;
    }
    rows.forEach(function (row) {
      var cells = '';
      for (var i = 0; i < cols.length; i++) cells += cellXml(book, colName(i) + r, row[i], cols[i]);
      out.push('<row r="' + r + '">' + cells + '</row>');
      r++;
    });
    out.push('</sheetData>');
    if (sh.protect) out.push('<sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" formatRows="0" autoFilter="0" sort="0"/>'); // no password: guards against accidents only
    if (header && rows.length && sh.autoFilter !== false) out.push('<autoFilter ref="A1:' + lastCol + lastRow + '"/>');
    var vals = sh.validations || [];
    if (vals.length) {
      out.push('<dataValidations count="' + vals.length + '">' + vals.map(function (v) {
        var cn = colName(v.col), last = Math.max(lastRow, 2);
        return '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="stop"' +
          (v.title ? ' errorTitle="' + esc(v.title) + '" promptTitle="' + esc(v.title) + '"' : '') + (v.error ? ' error="' + esc(v.error) + '"' : '') + (v.prompt ? ' prompt="' + esc(v.prompt) + '"' : '') +
          ' sqref="' + cn + '2:' + cn + last + '"><formula1>"' + esc(v.list.join(',')) + '"</formula1></dataValidation>';
      }).join('') + '</dataValidations>');
    }
    out.push('</worksheet>');
    return out.join('');
  }

  function safeSheetName(n, used) {
    var base = String(n || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31) || 'Sheet', name = base, k = 2;
    while (used[name.toLowerCase()]) { var suf = ' ' + k++; name = base.slice(0, 31 - suf.length) + suf; }
    used[name.toLowerCase()] = true;
    return name;
  }

  function build(sheets) {
    var used = {}, book = new StyleBook(), names = sheets.map(function (s) { return safeSheetName(s.name, used); }), files = [];
    var sheetFiles = sheets.map(function (s, i) { s.index = i; return utf8(sheetXml(s, book)); }); // styles are collected while the sheets are written
    files.push({ name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
    var defined = sheets.map(function (s, i) {
      if (s.header === false || !(s.rows || []).length || s.autoFilter === false) return '';
      return '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + esc(names[i]).replace(/'/g, "''") + '\'!$A$1:$' + colName(s.columns.length - 1) + '$' + (s.rows.length + 1) + '</definedName>';
    }).join('');
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
      names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets>' + (defined ? '<definedNames>' + defined + '</definedNames>' : '') + '</workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') });
    files.push({ name: 'xl/styles.xml', data: utf8(book.xml()) });
    sheetFiles.forEach(function (d, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: d }); });
    return zip(files);
  }

  var api = { build: build, serial: serial, crc32: crc32, colName: colName, safeSheetName: function (n, used) { return safeSheetName(n, used || {}); } };
  root.HMGXlsxPro = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
