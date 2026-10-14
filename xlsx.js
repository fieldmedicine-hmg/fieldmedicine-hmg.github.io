// Minimal, dependency-free .xlsx writer (2026-10-14, Zone Manager approvals export).
// The page CSP only allows scripts from this site, so no CDN library can be used.
// Produces a standard Office Open XML workbook (uncompressed ZIP, inline strings):
// bold frozen header row, auto-filter, column widths, and REAL Excel date/time
// cells. Date/time values arrive as wall-clock strings already rendered in
// Asia/Riyadh by the backend ('yyyy-MM-dd', 'yyyy-MM-dd HH:mm[:ss]', 'HH:mm') and
// are converted to Excel serials WITHOUT any time-zone shift, so Excel shows
// exactly the Riyadh time the system recorded.
// Usage: HMGXlsx.build([{ name, columns: [{ header, type, width }], rows: [[...]] }]) -> Uint8Array
//   type: 'text' (default; numbers stay numbers) | 'string' (always text, e.g. codes/ids) | 'number' | 'wrap'
//         | 'date' | 'datetime' | 'datetimeMin' | 'time'
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(s); }

  /** Stored (method 0) ZIP of [{ name, data: Uint8Array }]. */
  function zip(files) {
    var parts = [], central = [], offset = 0;
    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    files.forEach(function (f) {
      var name = utf8(f.name), crc = crc32(f.data), size = f.data.length;
      // version 20, flag 0x0800 (UTF-8 names), method 0, time/date 0 (1980-01-01)
      var local = [].concat([0x50, 0x4B, 0x03, 0x04], u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0));
      parts.push(new Uint8Array(local), name, f.data);
      central.push(new Uint8Array([].concat([0x50, 0x4B, 0x01, 0x02], u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += local.length + name.length + size;
    });
    var centralSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4B, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)));
    var all = parts.concat(central, [end]);
    var total = all.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  function esc(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  // Excel serial for a wall-clock date/time (1900 date system; serial 25569 = 1970-01-01).
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  var TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  function serial(v, type) {
    var s = String(v).trim(), m;
    if (type === 'time' && (m = TIME_RE.exec(s))) return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0)) / 86400;
    if ((m = DATE_RE.exec(s))) {
      var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
      return ms / 86400000 + 25569;
    }
    return null; // not a recognisable date -> written as text, never guessed
  }

  // cellXfs: 0 default, 1 header, 2 date, 3 datetime (sec), 4 time, 5 datetime (min), 6 wrapped text
  var STYLE = { date: 2, datetime: 3, time: 4, datetimeMin: 5 };
  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/>' +
    '<numFmt numFmtId="166" formatCode="hh:mm"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A1A"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function cellXml(ref, v, type) {
    if (v === null || v === undefined || v === '') return '';
    if (STYLE[type]) {
      var n = serial(v, type);
      if (n !== null) return '<c r="' + ref + '" s="' + STYLE[type] + '"><v>' + n + '</v></c>';
    }
    if (type !== 'string' && (type === 'number' || typeof v === 'number') && isFinite(Number(v))) return '<c r="' + ref + '"><v>' + Number(v) + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"' + (type === 'wrap' ? ' s="6"' : '') + '><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sh) {
    var cols = sh.columns, rows = sh.rows || [], header = sh.header !== false;
    var lastCol = colName(Math.max(cols.length, 1) - 1), lastRow = rows.length + (header ? 1 : 0);
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
    if (header) out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    out.push('<cols>' + cols.map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || Math.min(Math.max(String(c.header || '').length + 4, 10), 40)) + '" customWidth="1"/>';
    }).join('') + '</cols><sheetData>');
    var r = 1;
    if (header) {
      out.push('<row r="1">' + cols.map(function (c, i) {
        return '<c r="' + colName(i) + '1" t="inlineStr" s="1"><is><t xml:space="preserve">' + esc(c.header) + '</t></is></c>';
      }).join('') + '</row>');
      r = 2;
    }
    rows.forEach(function (row) {
      var cells = '';
      for (var i = 0; i < cols.length; i++) cells += cellXml(colName(i) + r, row[i], cols[i].type);
      out.push('<row r="' + r + '">' + cells + '</row>');
      r++;
    });
    out.push('</sheetData>');
    if (header && rows.length) out.push('<autoFilter ref="A1:' + lastCol + lastRow + '"/>');
    out.push('</worksheet>');
    return out.join('');
  }

  function safeSheetName(n, used) {
    var base = String(n || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || 'Sheet', name = base, k = 2;
    while (used[name.toLowerCase()]) { name = base.slice(0, 28) + ' ' + k++; }
    used[name.toLowerCase()] = true;
    return name;
  }

  function build(sheets) {
    var used = {};
    var names = sheets.map(function (s) { return safeSheetName(s.name, used); });
    var files = [];
    files.push({ name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
    var defined = sheets.map(function (s, i) {
      if (s.header === false || !(s.rows || []).length) return '';
      return '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + esc(names[i]).replace(/'/g, "''") + '\'!$A$1:$' +
        colName(s.columns.length - 1) + '$' + (s.rows.length + 1) + '</definedName>';
    }).join('');
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map(function (n, i) { return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets>' + (defined ? '<definedNames>' + defined + '</definedNames>' : '') + '</workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') });
    files.push({ name: 'xl/styles.xml', data: utf8(STYLES_XML) });
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s)) }); });
    return zip(files);
  }

  root.HMGXlsx = { build: build, _serial: serial, _crc32: crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HMGXlsx;
})(typeof window !== 'undefined' ? window : globalThis);
