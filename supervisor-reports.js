/* HMG supervisor operational reports (V1.5, 2026-11-17) - PURE functions shared by supervisor.js and the Node tests (no DOM, no network).
 * Input = svList records (V1.5 fields: attendance, missing, effective{checkIn,checkOut}, effectiveMinutes, approvalLabel, payable ... ).
 * Every field is optional: an older backend is tolerated (attendance is derived from the current checkIn / checkOut presence).
 * SVReports.attendanceOf(c)                 -> 'MATCH' | 'CHECK_IN_ONLY' | 'CHECK_OUT_ONLY' | '' (no punch at all)
 * SVReports.selectMissing(records, opts)    -> { zones: {zone: [rec]}, all: [rec], rejected: [rec], cross: [pair], counts }
 * SVReports.missingWorkbooks(sel, perZone, range) -> [{ name, sheets }]   (HMGXlsx.build input; one file, or one file per zone)
 * SVReports.completeWorkbook(records, scope, range) -> { name, sheets, count }   (MATCH only, neutral wording)
 * SVReports.crossZonePairs(records)         -> [{ checkIn: rec, checkOut: rec, gapMin }]
 * SVReports.buildWhatsApp({date, zone, records, scopeZones}) -> { text, counts, lines }
 * SVReports.waLink(text)                    -> { url, truncated }
 * SVReports.visibleZones(scopeZones, zones) -> zones the user may see
 * The operational files never contain the words modified / corrected / adjusted / exception (SVReports.FORBIDDEN tests that).
 */
(function (root) {
  'use strict';
  var FORBIDDEN = /modified|corrected|adjusted|exception|معدل|معدّل|مصحح|مصحّح|استثناء/i;
  var CROSS_MAX_MIN = 16 * 60;
  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function has(v) { return v !== null && v !== undefined && v !== ''; }

  function effectiveOf(c) {
    var e = c && c.effective;
    if (e && (has(e.checkIn) || has(e.checkOut))) return { checkIn: str(e.checkIn), checkOut: str(e.checkOut) };
    return { checkIn: str(c && c.checkIn), checkOut: str(c && c.checkOut) };
  }
  function attendanceOf(c) {
    var a = str(c && c.attendance).toUpperCase();
    if (a === 'MATCH' || a === 'CHECK_IN_ONLY' || a === 'CHECK_OUT_ONLY') return a;
    var e = effectiveOf(c);
    if (e.checkIn && e.checkOut) return 'MATCH';
    if (e.checkIn) return 'CHECK_IN_ONLY';
    if (e.checkOut) return 'CHECK_OUT_ONLY';
    return '';
  }
  function approvalLabelOf(c) {
    var l = str(c && c.approvalLabel).toUpperCase();
    if (l === 'APPROVED' || l === 'SUPERVISOR_APPROVED' || l === 'PENDING_ZONE_MANAGER' || l === 'REJECTED' || l === 'FINAL') return l;
    var zm = str(c && c.zmStatus).toUpperCase(), ls = str(c && c.listState).toUpperCase();
    if (zm === 'REJECTED' || ls === 'REJECTED') return 'REJECTED';
    if (ls === 'FINAL') return 'FINAL';
    if (zm === 'APPROVED' || zm === 'MODIFIED' || zm === 'FORWARDED') return 'APPROVED';
    if (c && c.correction && c.correction.approvalPath === 'SUPERVISOR_DIRECT') return 'SUPERVISOR_APPROVED';
    return 'PENDING_ZONE_MANAGER';
  }
  var APPROVAL_TEXT = { APPROVED: 'Approved', SUPERVISOR_APPROVED: 'Approved by supervisor - Zone Manager pending', PENDING_ZONE_MANAGER: 'Pending Zone Manager', REJECTED: 'Rejected', FINAL: 'FINAL' };
  function approvalText(c) { var l = approvalLabelOf(c); return APPROVAL_TEXT[l] || l; }
  function parseMin(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(str(s));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
  }
  function minutesOf(c) {
    if (has(c && c.effectiveMinutes) && !isNaN(Number(c.effectiveMinutes))) return Number(c.effectiveMinutes);
    var e = effectiveOf(c), a = parseMin(e.checkIn), b = parseMin(e.checkOut);
    return a !== null && b !== null && b > a ? b - a : null;
  }
  function hm(m) { return m === null || m === undefined || isNaN(m) ? '' : Math.floor(m / 60) + ':' + ('0' + (Math.round(m) % 60)).slice(-2); }
  function isPayable(c) {
    if (attendanceOf(c) !== 'MATCH') return false;
    if (c && typeof c.payable === 'boolean') return c.payable;
    var l = approvalLabelOf(c);
    if (l === 'APPROVED') return true;
    if (l === 'FINAL') { var b = str(c && c.approvalBase).toUpperCase(); return b === 'APPROVED'; }
    return false;
  }
  function zoneKey(c) { return str(c && c.zone) || 'No zone'; }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function sortRecs(list) {
    return list.slice().sort(function (a, b) { return cmp(zoneKey(a), zoneKey(b)) || cmp(str(a.workDate), str(b.workDate)) || cmp(str(a.employeeCode), str(b.employeeCode)) || cmp(str(a.event), str(b.event)); });
  }
  function visibleZones(scopeZones, zones) {
    var z = (zones || []).filter(Boolean);
    if (!scopeZones || !scopeZones.length) return z;
    var ok = {}; scopeZones.forEach(function (s) { ok[String(s).toLowerCase()] = 1; });
    return z.filter(function (n) { return ok[String(n).toLowerCase()]; });
  }
  function inScope(records, scopeZones) {
    if (!scopeZones || !scopeZones.length) return records.slice();
    var ok = {}; scopeZones.forEach(function (s) { ok[String(s).toLowerCase()] = 1; });
    return records.filter(function (c) { return ok[str(c.zone).toLowerCase()]; });
  }

  /** Same code: Check-in Only in zone A + Check-out Only in zone B, check-out 0..16 h after the check-in (overnight works: full date-times are compared). */
  function crossZonePairs(records) {
    var byCode = {}, out = [];
    (records || []).forEach(function (c) {
      var a = attendanceOf(c); if (a !== 'CHECK_IN_ONLY' && a !== 'CHECK_OUT_ONLY') return;
      var k = str(c.employeeCode); (byCode[k] = byCode[k] || { ins: [], outs: [] })[a === 'CHECK_IN_ONLY' ? 'ins' : 'outs'].push(c);
    });
    Object.keys(byCode).sort().forEach(function (k) {
      byCode[k].ins.forEach(function (i) {
        var ti = parseMin(effectiveOf(i).checkIn); if (ti === null) return;
        byCode[k].outs.forEach(function (o) {
          if (zoneKey(i).toLowerCase() === zoneKey(o).toLowerCase()) return;
          var to = parseMin(effectiveOf(o).checkOut); if (to === null) return;
          var gap = to - ti;
          if (gap >= 0 && gap <= CROSS_MAX_MIN) out.push({ checkIn: i, checkOut: o, gapMin: gap });
        });
      });
    });
    return out;
  }

  function selectMissing(records, opts) {
    opts = opts || {};
    var recs = inScope(records || [], opts.scopeZones).filter(function (c) { var a = attendanceOf(c); return a === 'CHECK_IN_ONLY' || a === 'CHECK_OUT_ONLY'; });
    var rejected = recs.filter(function (c) { return approvalLabelOf(c) === 'REJECTED'; });
    var open = recs.filter(function (c) { return approvalLabelOf(c) !== 'REJECTED'; });
    var cross = crossZonePairs(open), inCross = [];
    cross.forEach(function (p) { inCross.push(p.checkIn, p.checkOut); });
    var plain = open.filter(function (c) { return inCross.indexOf(c) === -1; }), zones = {};
    sortRecs(plain).forEach(function (c) { (zones[zoneKey(c)] = zones[zoneKey(c)] || []).push(c); });
    return { zones: zones, all: sortRecs(plain), rejected: sortRecs(rejected), cross: cross,
      counts: { missing: plain.length, rejected: rejected.length, cross: cross.length, zones: Object.keys(zones).length } };
  }

  var MISS_COLS = [['Employee Code', 'string', 14], ['Employee Name', 'text', 26], ['Zone', 'text', 18], ['Event', 'text', 22], ['Work Date', 'date', 13], ['Missing Punch', 'text', 16], ['Check-in', 'datetimeMin', 18], ['Check-out', 'datetimeMin', 18], ['Approval Status', 'text', 34]];
  var CROSS_COLS = [['Employee Code', 'string', 14], ['Employee Name', 'text', 26], ['Check-in Zone', 'text', 18], ['Check-in Event', 'text', 22], ['Check-in Work Date', 'date', 14], ['Check-in', 'datetimeMin', 18], ['Check-out Zone', 'text', 18], ['Check-out Event', 'text', 22], ['Check-out Work Date', 'date', 14], ['Check-out', 'datetimeMin', 18], ['Gap (h:mm)', 'string', 11], ['Review', 'text', 30]];
  function cols(list) { return list.map(function (x) { return { header: x[0], type: x[1], width: x[2] }; }); }
  function missRow(c) {
    var e = effectiveOf(c), a = attendanceOf(c);
    return [str(c.employeeCode), str(c.employeeName), str(c.zone), str(c.event), str(c.workDate), a === 'CHECK_IN_ONLY' ? 'Check-out' : 'Check-in', e.checkIn, e.checkOut, approvalText(c)];
  }
  function crossRow(p) {
    var i = p.checkIn, o = p.checkOut;
    return [str(i.employeeCode), str(i.employeeName || o.employeeName), str(i.zone), str(i.event), str(i.workDate), effectiveOf(i).checkIn, str(o.zone), str(o.event), str(o.workDate), effectiveOf(o).checkOut, hm(p.gapMin), 'Same person - confirm the zone before approving'];
  }
  /** Zone sheets + All_Zones + Rejected + Cross_Zone_Review. perZone = one workbook per zone (its sheet + its rejected rows + the cross-zone pairs it takes part in). */
  function missingWorkbooks(sel, perZone, range) {
    var tag = range ? '_' + range.from + '_' + range.to : '';
    function sheet(name, recs) { return { name: name, columns: cols(MISS_COLS), rows: recs.map(missRow) }; }
    function crossSheet(pairs) { return { name: 'Cross_Zone_Review', columns: cols(CROSS_COLS), rows: pairs.map(crossRow) }; }
    if (!perZone) {
      var sheets = [sheet('All_Zones', sel.all)];
      Object.keys(sel.zones).sort().forEach(function (z) { sheets.push(sheet(z, sel.zones[z])); });
      sheets.push(sheet('Rejected', sel.rejected), crossSheet(sel.cross));
      return [{ name: 'HMG_Missing_Punches' + tag + '.xlsx', sheets: sheets }];
    }
    var names = {}; Object.keys(sel.zones).forEach(function (z) { names[z] = 1; });
    sel.rejected.forEach(function (c) { names[zoneKey(c)] = 1; });
    sel.cross.forEach(function (p) { names[zoneKey(p.checkIn)] = 1; names[zoneKey(p.checkOut)] = 1; });
    return Object.keys(names).sort().map(function (z) {
      var zl = z.toLowerCase();
      return { name: 'HMG_Missing_Punches_' + z.replace(/[^A-Za-z0-9؀-ۿ]+/g, '_').replace(/^_+|_+$/g, '') + tag + '.xlsx', zone: z, sheets: [
        sheet(z, sel.zones[z] || []),
        sheet('Rejected', sel.rejected.filter(function (c) { return zoneKey(c).toLowerCase() === zl; })),
        crossSheet(sel.cross.filter(function (p) { return zoneKey(p.checkIn).toLowerCase() === zl || zoneKey(p.checkOut).toLowerCase() === zl; }))] };
    });
  }

  var COMP_COLS = [['Employee Code', 'string', 14], ['Employee Name', 'text', 26], ['Zone', 'text', 18], ['Event', 'text', 22], ['Work Date', 'date', 13], ['Check-in', 'datetimeMin', 18], ['Check-out', 'datetimeMin', 18], ['Total Working Hours', 'string', 18], ['Attendance Status', 'text', 16], ['Approval Status', 'text', 34], ['Payable Hours', 'string', 14]];
  /** MATCH only. Times are the times in force (never labelled by origin). Payable Hours stays blank unless the record is payable. */
  function completeWorkbook(records, scopeZones, range) {
    var recs = sortRecs(inScope(records || [], scopeZones).filter(function (c) { return attendanceOf(c) === 'MATCH'; }));
    var rows = recs.map(function (c) {
      var e = effectiveOf(c), m = minutesOf(c);
      return [str(c.employeeCode), str(c.employeeName), str(c.zone), str(c.event), str(c.workDate), e.checkIn, e.checkOut, hm(m), 'MATCH', approvalText(c), isPayable(c) ? hm(m) : ''];
    });
    return { name: 'HMG_Complete_Attendance' + (range ? '_' + range.from + '_' + range.to : '') + '.xlsx', sheets: [{ name: 'Complete Attendance', columns: cols(COMP_COLS), rows: rows }], count: rows.length };
  }

  function tm(s) { var m = /(\d{2}:\d{2})$/.exec(str(s)); return m ? m[1] : ''; }
  /** The message lists the CURRENT missing punches of one zone and one work date. */
  function buildWhatsApp(o) {
    var zone = str(o.zone), date = str(o.date), zl = zone.toLowerCase();
    var recs = inScope(o.records || [], o.scopeZones).filter(function (c) {
      var a = attendanceOf(c);
      return (a === 'CHECK_IN_ONLY' || a === 'CHECK_OUT_ONLY') && str(c.zone).toLowerCase() === zl && str(c.workDate) === date && approvalLabelOf(c) !== 'REJECTED';
    });
    recs = sortRecs(recs);
    var nIn = recs.filter(function (c) { return attendanceOf(c) === 'CHECK_IN_ONLY'; }).length, nOut = recs.length - nIn;
    var lines = recs.map(function (c, i) {
      var a = attendanceOf(c), e = effectiveOf(c);
      return (i + 1) + '. ' + str(c.employeeCode) + ' - ' + str(c.employeeName) + (c.event ? ' - ' + str(c.event) : '') + ' - ' +
        (a === 'CHECK_IN_ONLY' ? 'دخول ' + tm(e.checkIn) + ' / In ' + tm(e.checkIn) + ' (ناقص الخروج / missing check-out)' : 'خروج ' + tm(e.checkOut) + ' / Out ' + tm(e.checkOut) + ' (ناقص الدخول / missing check-in)');
    });
    var head = ['*HMG - البصمات الناقصة / Missing punches*', 'المنطقة / Zone: ' + zone, 'التاريخ / Date: ' + date,
      'الإجمالي / Total: ' + recs.length, 'دخول فقط / Check-in only: ' + nIn, 'خروج فقط / Check-out only: ' + nOut];
    var text = head.join('\n') + '\n' + (lines.length ? '\n' + lines.join('\n') + '\n\nيرجى تزويدنا بالوقت الصحيح. / Please send the correct time.' : '\nلا توجد بصمات ناقصة. / No missing punches.');
    return { text: text, counts: { total: recs.length, checkInOnly: nIn, checkOutOnly: nOut }, lines: lines };
  }
  /** wa.me link (the browser opens it only on a click). Very long messages are cut so the address stays usable; the Copy button always holds the full text. */
  function waLink(text) {
    var MAX = 3600, t = str(text), cut = false;
    if (encodeURIComponent(t).length > MAX) {
      var ls = t.split('\n'), note = '\n... (باقي القائمة في النص المنسوخ / rest of the list: use Copy)';
      while (ls.length > 1 && encodeURIComponent(ls.join('\n') + note).length > MAX) ls.pop();
      t = ls.join('\n') + note; cut = true;
    }
    return { url: 'https://wa.me/?text=' + encodeURIComponent(t), truncated: cut };
  }

  var api = { FORBIDDEN: FORBIDDEN, attendanceOf: attendanceOf, effectiveOf: effectiveOf, approvalLabelOf: approvalLabelOf, approvalText: approvalText, isPayable: isPayable, minutesOf: minutesOf, hm: hm,
    crossZonePairs: crossZonePairs, selectMissing: selectMissing, missingWorkbooks: missingWorkbooks, completeWorkbook: completeWorkbook, buildWhatsApp: buildWhatsApp, waLink: waLink, visibleZones: visibleZones, inScope: inScope };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SVReports = api;
  if (typeof window !== 'undefined') window.SVReports = api;
})(typeof window !== 'undefined' ? window : this);
