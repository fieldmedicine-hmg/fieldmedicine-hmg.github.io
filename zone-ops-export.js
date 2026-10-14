// Daily Zone report -> Excel workbook layout (Phase 6, 2026-10-14).
// Pure functions: the workbook is built from the SAME report response (same versioned snapshots and hashes) that the
// PDF of that request was rendered from, so the two can always be reconciled. No token or phone number is ever part
// of the response, so none can reach the file.
(function (root) {
  'use strict';

  function diffText(x) { return !x || x.diff === null || x.diff === undefined ? '' : (x.diff > 0 ? '+' + x.diff : String(x.diff)); }
  function shiftLines(c) {
    var s = c.staffing;
    return c.config.mode === 'MORNING_NIGHT' ? [['MORNING', s.morning], ['NIGHT', s.night], ['DAILY TOTAL', s.total]] : [['DAILY TOTAL', s.total]];
  }
  function hoursMin(v) { return v === null || v === undefined || v === '' ? '' : v; }

  function workbookSheets(resp) {
    var reports = resp.reports || [];
    var summary = [], detail = [], unmatched = [], decisions = [], info = [];
    reports.forEach(function (r) {
      var c = r.content, ver = r.status === 'FINAL' ? 'FINAL v' + r.version : 'DRAFT';
      shiftLines(c).forEach(function (l) {
        var x = l[1] || {};
        summary.push([c.date, c.zone, c.city, c.config.mode, c.config.policy, l[0], x.required === null || x.required === undefined ? '' : x.required, x.approved === undefined ? '' : x.approved,
          x.unresolved || 0, diffText(x), x.status || '', c.staffing.uniqueHeadcount, c.staffing.shiftCoverage, c.counts.hoursUnmatched, c.counts.pending + c.counts.notReviewed + c.counts.unresolved,
          c.counts.disagreements, ver, String(r.hash).slice(0, 16)]);
        if (x.status === 'UNMATCHED' || x.status === 'PENDING' || x.status === 'NO_TARGET') {
          unmatched.push([c.date, c.zone, 'STAFFING', l[0], '', '', x.status, 'Required ' + (x.required === null || x.required === undefined ? '—' : x.required) + ', approved ' + x.approved +
            (x.unresolved ? ', unresolved ' + x.unresolved : '') + (diffText(x) ? ' (' + diffText(x) + ')' : ''), ver]);
        }
      });
      c.employees.forEach(function (e) {
        detail.push([c.date, c.zone, e.code, e.name, e.designation, e.source, e.shift, e.originalIn, e.originalOut, e.approvedIn, e.approvedOut, e.timeSource,
          e.actualHours, e.requiredHours, e.varianceHours, hoursMin(e.varianceMin), e.hoursStatus, e.hoursReason, e.approvalState, e.officialDecision, e.finalStatus,
          e.officialReviewer, e.decidedAt, e.policy, e.agreement, e.opinions.length, e.counted ? 'YES' : 'NO', e.exceptions.join(' | '),
          e.recordId, e.supplementId, e.reviewId, e.checkinSubmissionId, e.checkoutSubmissionId, ver]);
        if (e.hoursStatus === 'UNMATCHED' || e.hoursStatus === 'NOT_COMPUTABLE') {
          unmatched.push([c.date, c.zone, 'HOURS', e.shift, e.code, e.name, e.hoursStatus, e.hoursReason + (e.actualHours ? ' (actual ' + e.actualHours + ', required ' + e.requiredHours + ')' : ''), ver]);
        }
        if (['PENDING', 'NOT_SENT', 'NOT_REVIEWED', 'UNRESOLVED'].indexOf(e.approvalState) !== -1) {
          unmatched.push([c.date, c.zone, 'APPROVAL', e.shift, e.code, e.name, e.approvalState, e.exceptions.join(' | '), ver]);
        }
        if (e.agreement === 'DISAGREE' || e.agreement === 'PARTIAL') {
          unmatched.push([c.date, c.zone, 'MANAGER DISAGREEMENT', e.shift, e.code, e.name, e.agreement,
            e.opinions.map(function (o) { return o.name + ' (' + o.role + '): ' + o.decision + (o.comment ? ' - ' + o.comment : ''); }).join(' | '), ver]);
        }
        e.opinions.forEach(function (o, i) {
          decisions.push([c.date, c.zone, e.code, e.name, i + 1, o.name, o.managerId, o.role, o.decision, o.comment, o.decidedAt, e.agreement, e.officialDecision, e.approvalState, ver]);
        });
      });
      (c.orphanDecisions || []).forEach(function (o) {
        unmatched.push([c.date, c.zone, 'ORPHAN DECISION', '', o.code, o.name, o.decision, 'Official decision by ' + (o.reviewer || '—') + ' at ' + o.decidedAt + ' (Review ID ' + o.reviewId + ') has no attendance record - not counted, nothing fabricated', ver]);
      });
      info.push([c.date, c.zone, c.zoneId, r.status, r.version || '', r.reportId || '', r.generatedAt, r.generatedBy, r.hash, r.integrityOk === false ? 'FAILED' : 'OK',
        r.liveChanged ? 'YES - live data changed after finalization; this sheet shows the issued FINAL figures' : 'NO', c.config.version, c.config.effectiveFrom, c.config.toleranceMin,
        c.config.totalBasis, c.managers.map(function (m) { return m.name + ' (' + m.role + (m.required ? ', required' : '') + ')'; }).join('; ') || 'legacy single reviewer',
        (c.blockers || []).join(' | ')]);
    });
    return [
      { name: 'Summary', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 22 }, { header: 'City' }, { header: 'Mode', width: 15 }, { header: 'Approval Policy', width: 22 },
        { header: 'Shift', width: 13 }, { header: 'Required', type: 'number' }, { header: 'Approved', type: 'number' }, { header: 'Unresolved', type: 'number' }, { header: 'Shortage / Excess', type: 'string' },
        { header: 'Staffing Status', width: 14 }, { header: 'Unique Headcount', type: 'number' }, { header: 'Shift Coverage', type: 'number' }, { header: 'Hours Unmatched', type: 'number' },
        { header: 'Pending / Unresolved Records', type: 'number' }, { header: 'Manager Disagreements', type: 'number' }, { header: 'Report', width: 10 }, { header: 'Snapshot', type: 'string', width: 18 }], rows: summary },
      { name: 'Employee Detail', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 }, { header: 'Designation' },
        { header: 'Source', width: 22 }, { header: 'Shift' }, { header: 'Original Check-in', type: 'datetimeMin', width: 17 }, { header: 'Original Check-out', type: 'datetimeMin', width: 17 },
        { header: 'Approved Check-in', type: 'datetimeMin', width: 17 }, { header: 'Approved Check-out', type: 'datetimeMin', width: 17 }, { header: 'Time Source', width: 16 },
        { header: 'Actual Hours', type: 'string' }, { header: 'Required Hours', type: 'string' }, { header: 'Variance', type: 'string' }, { header: 'Variance (min)', type: 'number' },
        { header: 'Hours Status', width: 15 }, { header: 'Hours Reason', type: 'wrap', width: 30 }, { header: 'Approval State', width: 14 }, { header: 'Official Decision' }, { header: 'Final Status', width: 18 },
        { header: 'Official Reviewer', width: 20 }, { header: 'Decided At', type: 'datetimeMin', width: 17 }, { header: 'Approval Policy', width: 22 }, { header: 'Manager Agreement' },
        { header: 'Manager Opinions', type: 'number' }, { header: 'Counted In Headcount' }, { header: 'Exceptions', type: 'wrap', width: 50 }, { header: 'Attendance Record ID', type: 'string', width: 24 },
        { header: 'Supplement ID', type: 'string', width: 22 }, { header: 'Manager Review ID', type: 'string', width: 38 }, { header: 'Check-in Submission ID', type: 'string', width: 22 },
        { header: 'Check-out Submission ID', type: 'string', width: 22 }, { header: 'Report', width: 10 }], rows: detail },
      { name: 'Unmatched Cases', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Type', width: 22 }, { header: 'Shift' }, { header: 'Employee Code', type: 'string' },
        { header: 'Employee Name', width: 26 }, { header: 'Status', width: 16 }, { header: 'Detail', type: 'wrap', width: 70 }, { header: 'Report', width: 10 }], rows: unmatched },
      { name: 'Manager Decisions', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 },
        { header: 'Order', type: 'number' }, { header: 'Manager', width: 22 }, { header: 'Manager ID', type: 'string' }, { header: 'Role', width: 20 }, { header: 'Decision' },
        { header: 'Reason / Comment', type: 'wrap', width: 40 }, { header: 'Decided At', type: 'datetimeMin', width: 17 }, { header: 'Agreement' }, { header: 'Official Decision' },
        { header: 'Approval State' }, { header: 'Report', width: 10 }], rows: decisions },
      { name: 'Report Info', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Zone ID', type: 'string' }, { header: 'Status' }, { header: 'Version', type: 'number' },
        { header: 'Report ID', type: 'string', width: 30 }, { header: 'Generated / Finalized At', type: 'datetime', width: 20 }, { header: 'By', width: 24 }, { header: 'Snapshot Hash (SHA-256)', type: 'string', width: 66 },
        { header: 'Integrity' }, { header: 'Live Data Changed Since Final', type: 'wrap', width: 40 }, { header: 'Config Version', type: 'string' }, { header: 'Config Effective From', type: 'string' },
        { header: 'Hours Tolerance (min)', type: 'number' }, { header: 'Daily Total Basis' }, { header: 'Managers', type: 'wrap', width: 40 }, { header: 'Open Blockers', type: 'wrap', width: 50 }],
        rows: info.concat([['', 'Request', '', resp.allFinal ? 'ALL FINAL' : 'CONTAINS DRAFT', '', '', resp.generatedAt, resp.generatedBy, resp.bundleHash, '', '', '', '', '', '', '', 'Time zone: ' + resp.timeZone]]) },
    ];
  }

  function fileName(resp) {
    var zones = (resp.reports || []).map(function (r) { return r.content.zoneId; });
    var tag = zones.length === 1 ? zones[0] : 'ALL-ZONES';
    return 'HMG_' + tag + '_' + resp.date + '_' + (resp.allFinal ? 'FINAL' : 'DRAFT') + '_' + String(resp.bundleHash || '').slice(0, 8) + '.xlsx';
  }

  root.HMGZoneOpsExport = { workbookSheets: workbookSheets, fileName: fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HMGZoneOpsExport;
})(typeof window !== 'undefined' ? window : globalThis);
