// Daily Zone report -> Excel workbook layout (Phase 6, 2026-10-14).
// Pure functions: the workbook is built from the SAME report response (same versioned snapshots and hashes) that the
// PDF of that request was rendered from, so the two can always be reconciled. No token or phone number is ever part
// of the response, so none can reach the file.
(function (root) {
  'use strict';

  function diffText(x) { return !x || x.diff === null || x.diff === undefined ? '' : (x.diff > 0 ? 'EXCESS ' + x.diff : (x.diff < 0 ? 'SHORTAGE ' + (-x.diff) : '0')); }
  function shiftLines(c) {
    var s = c.staffing;
    return c.config.mode === 'MORNING_NIGHT' ? [['MORNING', s.morning], ['NIGHT', s.night], ['DAILY TOTAL', s.total]] : [['DAILY TOTAL', s.total]];
  }
  function hoursMin(v) { return v === null || v === undefined || v === '' ? '' : v; }

  function workbookSheets(resp) {
    var reports = resp.reports || [];
    var summary = [], detail = [], unmatched = [], decisions = [], info = [], explRows = [];
    reports.forEach(function (r) {
      var c = r.content, ver = r.status === 'FINAL' ? 'FINAL v' + r.version : 'DRAFT';
      var pl = c.plan || { status: 'NONE' }, tg = c.target || null;
      shiftLines(c).forEach(function (l) {
        var x = l[1] || {};
        var gOf = l[0] === 'MORNING' ? pl.morning : (l[0] === 'NIGHT' ? pl.night : pl.scheduled);
        summary.push([c.date, c.zone, c.city, c.config.mode, c.config.policy, l[0], x.required === null || x.required === undefined ? '' : x.required, x.approved === undefined ? '' : x.approved,
          x.unresolved || 0, diffText(x), x.status === 'NO_TARGET' ? (pl.status === 'INCOMPLETE' ? 'INCOMPLETE' : (pl.status === 'NO_ACTIVE_EVENT' ? 'NO ACTIVE EVENT' : 'MISSING PLAN')) : (x.status === 'PENDING' ? 'PRELIMINARY' : x.status || ''), c.staffing.uniqueHeadcount, c.staffing.shiftCoverage, c.counts.hoursUnmatched, c.counts.pending + c.counts.notReviewed + c.counts.unresolved,
          c.counts.disagreements, ver, String(r.hash).slice(0, 16),
          // MANPOWER: expected (effective target) vs external plan - the external Present column is never the actual count
          tg ? (tg.source || 'MANUAL') + (tg.stale ? ' (STALE)' : '') : (pl.status === 'INCOMPLETE' ? 'INCOMPLETE' : (pl.status === 'NO_ACTIVE_EVENT' ? 'NO ACTIVE EVENT' : 'MISSING PLAN')), tg && tg.overrideStatus ? tg.overrideStatus : '', l[0] === 'DAILY TOTAL' ? (pl.approvedPlan === null || pl.approvedPlan === undefined ? '' : pl.approvedPlan) : '',
          gOf === null || gOf === undefined ? '' : gOf, l[0] === 'DAILY TOTAL' && pl.planDiff !== null && pl.planDiff !== undefined ? pl.planDiff : '', l[0] === 'DAILY TOTAL' ? (pl.discrepancy ? 'DISCREPANCY' : (pl.status === 'VALID' ? 'OK' : '')) : '',
          pl.status, pl.freshnessLabel || '', l[0] === 'DAILY TOTAL' && pl.status === 'INCOMPLETE' ? pl.knownPartial : '']);
        if (x.status === 'UNMATCHED' || x.status === 'PENDING' || x.status === 'NO_TARGET') {
          unmatched.push([c.date, c.zone, 'STAFFING', l[0], '', '', x.status, 'Required ' + (x.required === null || x.required === undefined ? '—' : x.required) + ', approved ' + x.approved +
            (x.unresolved ? ', unresolved ' + x.unresolved : '') + (diffText(x) ? ' (' + diffText(x) + ')' : ''), ver]);
        }
      });
      c.employees.forEach(function (e) {
        detail.push([c.date, c.zone, e.code, e.name, e.designation, e.source, e.shift, e.originalIn, e.originalOut, e.approvedIn, e.approvedOut, e.timeSource,
          e.actualHours, e.requiredHours, e.varianceHours, hoursMin(e.varianceMin), e.hoursStatus, e.hoursReason, (e.hoursCategory || '').replace('_', ' '), e.additionalHours || '',
          e.explanationStatus === 'NOT_REQUIRED' ? '' : e.explanationStatus, (e.explanations || []).map(function (x) { return x.name + ' (' + x.role + '): ' + x.decision + ' - ' + x.explanation; }).join(' | '),
          e.approvalState, e.officialDecision, e.finalStatus,
          e.officialReviewer, e.decidedAt, e.policy, e.agreement, e.opinions.length, e.counted ? 'YES' : 'NO', e.exceptions.join(' | '),
          e.recordId, e.supplementId, e.reviewId, e.checkinSubmissionId, e.checkoutSubmissionId, ver]);
        if (e.hoursStatus === 'UNMATCHED') {
          unmatched.push([c.date, c.zone, (e.hoursCategory || 'HOURS').replace('_', ' '), e.shift, e.code, e.name, 'UNMATCHED', e.hoursReason + ' (actual ' + e.actualHours + ', required ' + e.requiredHours + ') · explanation ' +
            (e.explanationStatus === 'PROVIDED' ? 'PROVIDED: ' + (e.explanations || []).map(function (x) { return x.name + ' ' + x.decision + ' - ' + x.explanation; }).join(' | ') : e.explanationStatus), ver]);
        }
        if (e.hoursStatus === 'NOT_COMPUTABLE') {
          unmatched.push([c.date, c.zone, 'MISSING PUNCH', e.shift, e.code, e.name, 'NOT_COMPUTABLE', e.hoursReason + (e.missingPunch ? (e.missingPunchAck ? ' · acknowledged by ' + e.missingPunchAck.by + ': ' + e.missingPunchAck.note : ' · acknowledgment REQUIRED') : ''), ver]);
        }
        (e.explanations || []).forEach(function (x) {
          explRows.push([c.date, c.zone, e.code, e.name, (e.hoursCategory || '').replace('_', ' '), e.requiredHours, e.actualHours, e.varianceHours, x.variance, x.name, x.managerId, x.role, x.decision, x.explanation,
            x.recordedAt, x.recordedBy, x.source, 'UNMATCHED (an approved explanation never makes the hours compliant)', ver]);
        });
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
        unmatched.push([c.date, c.zone, 'ORPHAN DECISION', '', o.code, o.name, o.decision, 'Official decision by ' + (o.reviewer || '—') + ' at ' + o.decidedAt + ' (Review ID ' + o.reviewId + ') has no attendance record - not counted, nothing fabricated' +
          (o.acknowledged ? ' · acknowledged by ' + o.acknowledged.by + ': ' + o.acknowledged.note : ' · acknowledgment REQUIRED'), ver]);
      });
      info.push([c.date, c.zone, c.zoneId, r.status, r.version || '', r.reportId || '', r.generatedAt, r.generatedBy, r.hash, r.integrityOk === false ? 'FAILED' : 'OK',
        r.liveChanged ? 'YES - live data changed after finalization; this sheet shows the issued FINAL figures' : 'NO', c.config.version, c.config.effectiveFrom, c.config.toleranceMin,
        c.config.totalBasis, c.managers.map(function (m) { return m.name + ' (' + m.role + (m.required ? ', required' : '') + ')'; }).join('; ') || ((c.routingReviewers || []).length ? c.routingReviewers.join('; ') + ' (single reviewer, Review_Routing)' : 'legacy single reviewer'),
        (c.blockers || []).join(' | ')]);
    });
    var agg = (resp.aggregate || []).map(function (z) {
      return [resp.fromDate || resp.date, resp.toDate || resp.date, z.zone, z.mode, z.days, z.finalDays, z.statusDays.MATCHED, z.statusDays.UNMATCHED, z.statusDays.PENDING, z.statusDays.NO_TARGET,
        z.requiredEmployeeDays, z.approvedEmployeeDays, z.morning.required, z.morning.approved, z.night.required, z.night.approved, z.shortageDays, z.shortage, z.excessDays, z.excess,
        z.uniqueEmployees, z.records, z.hoursUnmatched, z.overtimeHours, z.shortHours, z.explanationsMissing, z.pendingRecords, z.disagreements];
    });
    return [
      { name: 'Period Summary', columns: [{ header: 'From', type: 'date' }, { header: 'To', type: 'date' }, { header: 'Zone', width: 22 }, { header: 'Mode', width: 15 }, { header: 'Days', type: 'number' },
        { header: 'Final Days', type: 'number' }, { header: 'Days Matched', type: 'number' }, { header: 'Days Unmatched', type: 'number' }, { header: 'Days Pending', type: 'number' }, { header: 'Days No Target', type: 'number' },
        { header: 'Required Employee-Days', type: 'number' }, { header: 'Approved Employee-Days', type: 'number' }, { header: 'Morning Required', type: 'number' }, { header: 'Morning Approved', type: 'number' },
        { header: 'Night Required', type: 'number' }, { header: 'Night Approved', type: 'number' }, { header: 'Shortage Days', type: 'number' }, { header: 'Total Shortage', type: 'number' },
        { header: 'Excess Days', type: 'number' }, { header: 'Total Excess', type: 'number' }, { header: 'Unique Approved Employees', type: 'number' }, { header: 'Employee Records', type: 'number' },
        { header: 'Hours Unmatched', type: 'number' }, { header: 'Overtime (H:MM)', type: 'string' }, { header: 'Short Hours (H:MM)', type: 'string' }, { header: 'Explanations Missing', type: 'number' },
        { header: 'Open Records', type: 'number' }, { header: 'Manager Disagreements', type: 'number' }],
        rows: agg.concat(agg.length ? [['', '', 'NOTE', resp.aggregationNote || 'Each day is compared with its own target; period figures are sums of daily figures (employee-days).']] : []) },
      { name: 'Daily Staffing', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 22 }, { header: 'City' }, { header: 'Mode', width: 15 }, { header: 'Approval Policy', width: 22 },
        { header: 'Shift', width: 13 }, { header: 'Required', type: 'number' }, { header: 'Approved', type: 'number' }, { header: 'Unresolved', type: 'number' }, { header: 'Shortage / Excess', type: 'string' },
        { header: 'Staffing Status', width: 14 }, { header: 'Unique Headcount', type: 'number' }, { header: 'Shift Coverage', type: 'number' }, { header: 'Hours Unmatched', type: 'number' },
        { header: 'Pending / Unresolved Records', type: 'number' }, { header: 'Manager Disagreements', type: 'number' }, { header: 'Report', width: 10 }, { header: 'Snapshot', type: 'string', width: 18 },
        { header: 'Effective Expected Source', width: 22 }, { header: 'Override Status', type: 'wrap', width: 30 }, { header: 'External Approved (F)', type: 'number' }, { header: 'External Scheduled (G)', type: 'number' },
        { header: 'Plan Difference (G-F)', type: 'number' }, { header: 'Plan Check', width: 14 }, { header: 'Plan Status', width: 13 }, { header: 'Plan Source Freshness', type: 'wrap', width: 34 }, { header: 'Known Partial (G) - INCOMPLETE only', type: 'number' }], rows: summary },
      { name: 'Employee Detail', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 }, { header: 'Designation' },
        { header: 'Source', width: 22 }, { header: 'Shift' }, { header: 'Original Check-in', type: 'datetimeMin', width: 17 }, { header: 'Original Check-out', type: 'datetimeMin', width: 17 },
        { header: 'Approved Check-in', type: 'datetimeMin', width: 17 }, { header: 'Approved Check-out', type: 'datetimeMin', width: 17 }, { header: 'Time Source', width: 16 },
        { header: 'Actual Hours', type: 'string' }, { header: 'Required Hours', type: 'string' }, { header: 'Variance', type: 'string' }, { header: 'Variance (min)', type: 'number' },
        { header: 'Hours Status', width: 15 }, { header: 'Hours Reason', type: 'wrap', width: 30 }, { header: 'Hours Category', width: 14 }, { header: 'Additional Hours', type: 'string' },
        { header: 'Explanation Status', width: 14 }, { header: 'Manager Explanation(s)', type: 'wrap', width: 40 }, { header: 'Approval State', width: 14 }, { header: 'Official Decision' }, { header: 'Final Status', width: 18 },
        { header: 'Official Reviewer', width: 20 }, { header: 'Decided At', type: 'datetimeMin', width: 17 }, { header: 'Approval Policy', width: 22 }, { header: 'Manager Agreement' },
        { header: 'Manager Opinions', type: 'number' }, { header: 'Counted In Headcount' }, { header: 'Exceptions', type: 'wrap', width: 50 }, { header: 'Attendance Record ID', type: 'string', width: 24 },
        { header: 'Supplement ID', type: 'string', width: 22 }, { header: 'Manager Review ID', type: 'string', width: 38 }, { header: 'Check-in Submission ID', type: 'string', width: 22 },
        { header: 'Check-out Submission ID', type: 'string', width: 22 }, { header: 'Report', width: 10 }], rows: detail },
      { name: 'Hours Explanations', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 },
        { header: 'Category', width: 14 }, { header: 'Required', type: 'string' }, { header: 'Actual', type: 'string' }, { header: 'Difference', type: 'string' }, { header: 'Difference When Explained', type: 'string' },
        { header: 'Explained By', width: 22 }, { header: 'Manager ID', type: 'string' }, { header: 'Role', width: 14 }, { header: 'Decision' }, { header: 'Explanation', type: 'wrap', width: 45 },
        { header: 'Recorded At', type: 'datetimeMin', width: 17 }, { header: 'Recorded By', width: 24 }, { header: 'Source', width: 30 }, { header: 'Hours Status', width: 30 }, { header: 'Report', width: 10 }], rows: explRows },
      { name: 'Unmatched Cases', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Type', width: 22 }, { header: 'Shift' }, { header: 'Employee Code', type: 'string' },
        { header: 'Employee Name', width: 26 }, { header: 'Status', width: 16 }, { header: 'Detail', type: 'wrap', width: 70 }, { header: 'Report', width: 10 }], rows: unmatched },
      { name: 'Manager Decisions', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 },
        { header: 'Order', type: 'number' }, { header: 'Manager', width: 22 }, { header: 'Manager ID', type: 'string' }, { header: 'Role', width: 20 }, { header: 'Decision' },
        { header: 'Reason / Comment', type: 'wrap', width: 40 }, { header: 'Decided At', type: 'datetimeMin', width: 17 }, { header: 'Agreement' }, { header: 'Official Decision' },
        { header: 'Approval State' }, { header: 'Report', width: 10 }], rows: decisions },
      { name: 'Manpower Plan', columns: [{ header: 'Date', type: 'string' }, { header: 'Daily Log Zone', width: 22 }, { header: 'HMG Zone', width: 22 }, { header: 'Area', width: 22 }, { header: 'Shift' },
        { header: 'External Approved (F)', type: 'number' }, { header: 'External Scheduled (G)', type: 'number' }, { header: 'External Present (reference only, not used)', type: 'number' },
        { header: 'Shift Hours (E)', type: 'string' }, { header: 'Custom Hours (D)', type: 'wrap', width: 22 }, { header: 'Status', width: 16 }, { header: 'Reason', type: 'wrap', width: 50 },
        { header: 'Hours Note', type: 'wrap', width: 40 }, { header: 'Source Row', type: 'number' }],
        rows: ((resp.manpower && resp.manpower.rows) || []).map(function (x) { return [x.date, x.external, x.zone, x.area, x.shift, x.approved === null ? '' : x.approved, x.scheduled === null ? '' : x.scheduled,
          x.presentReferenceOnly === null || x.presentReferenceOnly === undefined ? '' : x.presentReferenceOnly, x.shiftHours, x.customHours, x.status, x.reason, x.hoursNote, x.sourceRow]; })
          .concat([['', 'Source', '', '', '', '', '', '', '', '', resp.manpower && resp.manpower.freshness ? resp.manpower.freshness.state : 'NONE', resp.manpower && resp.manpower.freshness ? resp.manpower.freshness.label : 'no Manpower data in this response', '', '']]) },
      { name: 'Report Info', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Zone ID', type: 'string' }, { header: 'Status' }, { header: 'Version', type: 'number' },
        { header: 'Report ID', type: 'string', width: 30 }, { header: 'Generated / Finalized At', type: 'datetime', width: 20 }, { header: 'By', width: 24 }, { header: 'Snapshot Hash (SHA-256)', type: 'string', width: 66 },
        { header: 'Integrity' }, { header: 'Live Data Changed Since Final', type: 'wrap', width: 40 }, { header: 'Config Version', type: 'string' }, { header: 'Config Effective From', type: 'string' },
        { header: 'Hours Tolerance (min)', type: 'number' }, { header: 'Daily Total Basis' }, { header: 'Managers', type: 'wrap', width: 40 }, { header: 'Open Blockers', type: 'wrap', width: 50 }],
        rows: info.concat([['', 'Request', '', resp.allFinal ? 'ALL FINAL' : 'CONTAINS DRAFT', '', '', resp.generatedAt, resp.generatedBy, resp.bundleHash, '', '', '', '', '', '', '', 'Time zone: ' + resp.timeZone]]) },
    ];
  }

  function fileName(resp) {
    var zones = (resp.reports || []).map(function (r) { return r.content.zoneId; });
    var uniq = {}; zones.forEach(function (z) { uniq[z] = true; });
    var tag = Object.keys(uniq).length === 1 ? zones[0] : 'ALL-ZONES';
    var period = resp.fromDate && resp.toDate && resp.fromDate !== resp.toDate ? resp.fromDate + '_to_' + resp.toDate : resp.date;
    return 'HMG_' + tag + '_' + period + '_' + (resp.allFinal ? 'FINAL' : 'DRAFT') + '_' + String(resp.bundleHash || '').slice(0, 8) + '.xlsx';
  }

  root.HMGZoneOpsExport = { workbookSheets: workbookSheets, fileName: fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HMGZoneOpsExport;
})(typeof window !== 'undefined' ? window : globalThis);
