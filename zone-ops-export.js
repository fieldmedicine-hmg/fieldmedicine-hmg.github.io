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
  // ---- hours approval display (2026-11-09): e.hoursView is sent by the backend (display rule lives there); the fallback only maps the computed status ----
  var VIEW_LABEL = { MATCHED: 'MATCHED', APPROVED: 'APPROVED', NOT_APPROVED: 'NOT APPROVED', NOT_COMPUTABLE: 'NOT COMPUTABLE', PENDING: 'PENDING', NA: 'N/A' };
  function viewOf(e) {
    if (e.hoursView && e.hoursView.status) return e.hoursView;
    return { status: { MATCHED: 'MATCHED', NOT_COMPUTABLE: 'NOT_COMPUTABLE', NO_REQUIREMENT: 'PENDING', NOT_APPLICABLE: 'NA' }[e.hoursStatus] || (e.hoursStatus === 'UNMATCHED' ? 'DIFFERENT' : e.hoursStatus),
      source: 'COMPUTED', kind: '', label: '', by: '', at: '', reason: '', adjusted: null };
  }
  function viewLabel(v) { return VIEW_LABEL[v.status] || (v.status === 'DIFFERENT' ? 'DIFFERENT FROM SHIFT' : String(v.status || '').replace(/_/g, ' ')); }
  function sourceText(v) { return v.source === 'AUTO' ? 'auto (no manager action)' : (v.source === 'MANAGER' ? 'manager' + (v.by ? ': ' + v.by : '') : 'computed'); }
  function checkText(e) { return e.hoursStatus === 'UNMATCHED' ? 'DIFFERENT FROM SHIFT' : (e.hoursStatus === 'MATCHED' ? 'MATCHED' : viewLabel(viewOf(e))); }
  function adjText(v, date) { var a = v.adjusted; return a ? a.start + '–' + a.end + (a.endDate && date && a.endDate > date ? ' (+1d)' : '') + ' ' + a.required : ''; }
  function hvCounts(c) {
    if (c.counts && c.counts.hoursView) return c.counts.hoursView;
    var k = { approved: 0, differs: 0 };
    c.employees.forEach(function (e) { if (viewOf(e).status === 'APPROVED') k.approved++; if (e.hoursStatus === 'UNMATCHED') k.differs++; });
    return k;
  }
  function expText(st) { return st === 'MISSING' ? 'NONE (optional)' : (st === 'STALE' ? 'OUTDATED (optional)' : (st === 'NOT_REQUIRED' ? '' : st)); }
  function hoursMin(v) { return v === null || v === undefined || v === '' ? '' : v; }

  function workbookSheets(resp) {
    var reports = resp.reports || [];
    var summary = [], detail = [], unmatched = [], decisions = [], info = [], explRows = [], hdecs = [];
    reports.forEach(function (r) {
      var c = r.content, ver = r.status === 'FINAL' ? 'FINAL v' + r.version : 'DRAFT';
      var pl = c.plan || { status: 'NONE' }, tg = c.target || null;
      shiftLines(c).forEach(function (l) {
        var x = l[1] || {};
        var gOf = l[0] === 'MORNING' ? pl.morning : (l[0] === 'NIGHT' ? pl.night : pl.scheduled);
        summary.push([c.date, c.zone, c.city, c.config.mode, c.config.policy, l[0], x.required === null || x.required === undefined ? '' : x.required, x.approved === undefined ? '' : x.approved,
          x.unresolved || 0, diffText(x), x.status === 'NO_TARGET' ? (pl.status === 'INCOMPLETE' ? 'INCOMPLETE' : (pl.status === 'NO_ACTIVE_EVENT' ? 'NO ACTIVE EVENT' : 'NO PLAN / بدون خطة')) : (x.status === 'PENDING' ? 'PRELIMINARY' : x.status || ''), c.staffing.uniqueHeadcount, c.staffing.shiftCoverage, hvCounts(c).differs, c.counts.pending + c.counts.notReviewed + c.counts.unresolved,
          c.counts.disagreements, ver, String(r.hash).slice(0, 16),
          // MANPOWER: expected (effective target) vs external plan - the external Present column is never the actual count
          tg ? (tg.source || 'MANUAL') + (tg.manualLines ? (tg.manualOnly ? ' (MANUAL PLAN)' : ' + MANUAL PLAN') : '') + (tg.stale ? ' (STALE)' : '') : (pl.status === 'INCOMPLETE' ? 'INCOMPLETE' : (pl.status === 'NO_ACTIVE_EVENT' ? 'NO ACTIVE EVENT' : 'NO PLAN / بدون خطة')), tg && tg.overrideStatus ? tg.overrideStatus : '', l[0] === 'DAILY TOTAL' ? (pl.approvedPlan === null || pl.approvedPlan === undefined ? '' : pl.approvedPlan) : '',
          gOf === null || gOf === undefined ? '' : gOf, l[0] === 'DAILY TOTAL' && pl.planDiff !== null && pl.planDiff !== undefined ? pl.planDiff : '', l[0] === 'DAILY TOTAL' ? (pl.discrepancy ? 'DISCREPANCY' : (pl.status === 'VALID' ? 'OK' : '')) : '',
          pl.status, pl.freshnessLabel || '', l[0] === 'DAILY TOTAL' && pl.status === 'INCOMPLETE' ? pl.knownPartial : '', hvCounts(c).approved || 0]);
        if (x.status === 'UNMATCHED' || x.status === 'PENDING' || x.status === 'NO_TARGET') {
          unmatched.push([c.date, c.zone, 'STAFFING', l[0], '', '', x.status, 'Required ' + (x.required === null || x.required === undefined ? '—' : x.required) + ', approved ' + x.approved +
            (x.unresolved ? ', unresolved ' + x.unresolved : '') + (diffText(x) ? ' (' + diffText(x) + ')' : ''), ver]);
        }
      });
      c.employees.forEach(function (e) {
        var hv = viewOf(e);
        detail.push([c.date, c.zone, e.code, e.name, e.designation, e.source, e.shift, e.originalIn, e.originalOut, e.approvedIn, e.approvedOut, e.timeSource,
          e.actualHours, e.requiredHours, e.varianceHours, hoursMin(e.varianceMin), viewLabel(hv), e.hoursReason, (e.hoursCategory || '').replace('_', ' '), e.additionalHours || '',
          expText(e.explanationStatus), (e.explanations || []).map(function (x) { return x.name + ' (' + x.role + '): ' + x.decision + ' - ' + x.explanation; }).join(' | '),
          e.approvalState, e.officialDecision, e.finalStatus,
          e.officialReviewer, e.decidedAt, e.policy, e.agreement, e.opinions.length, e.counted ? 'YES' : 'NO', e.exceptions.join(' | '),
          e.recordId, e.supplementId, e.reviewId, e.checkinSubmissionId, e.checkoutSubmissionId, ver,
          hv.label || '', hv.by || '', hv.at || '', checkText(e), hv.adjusted ? hv.adjusted.planRequired : '', adjText(hv, c.date)]);
        (e.hoursDecisions || []).forEach(function (d) {
          hdecs.push([c.date, c.zone, e.code, e.name, d.action, d.by, d.role, d.at, d.start && d.end ? d.start + '–' + d.end + (d.endDate && d.endDate > c.date ? ' (+1d)' : '') : '', d.required, d.actual, d.reason, d.binding === false ? 'NO (superseded / not binding)' : 'YES', d.source, ver]);
        });
        if (e.hoursStatus === 'UNMATCHED') {
          unmatched.push([c.date, c.zone, (e.hoursCategory || 'HOURS').replace('_', ' '), e.shift, e.code, e.name, viewLabel(hv), e.hoursReason + ' (actual ' + e.actualHours + ', required ' + e.requiredHours + (hv.adjusted ? ', adjusted work time ' + adjText(hv, c.date) + '; plan ' + hv.adjusted.planRequired : '') + ') · source ' + sourceText(hv) + (hv.label ? ' · ' + hv.label : '') + ' · explanation ' +
            (e.explanationStatus === 'PROVIDED' ? 'PROVIDED: ' + (e.explanations || []).map(function (x) { return x.name + ' ' + x.decision + ' - ' + x.explanation; }).join(' | ') : 'none (optional)'), ver]);
        }
        if (e.hoursStatus === 'NOT_COMPUTABLE') {
          unmatched.push([c.date, c.zone, 'MISSING PUNCH', e.shift, e.code, e.name, 'NOT_COMPUTABLE', e.hoursReason + (e.missingPunch ? (e.missingPunchAck ? ' · acknowledged by ' + e.missingPunchAck.by + ': ' + e.missingPunchAck.note : ' · acknowledgment REQUIRED') : ''), ver]);
        }
        (e.explanations || []).forEach(function (x) {
          explRows.push([c.date, c.zone, e.code, e.name, (e.hoursCategory || '').replace('_', ' '), e.requiredHours, e.actualHours, e.varianceHours, x.variance, x.name, x.managerId, x.role, x.decision, x.explanation,
            x.recordedAt, x.recordedBy, x.source, 'DIFFERENT FROM SHIFT - displayed as ' + viewLabel(hv) + ' (' + sourceText(hv) + '); the real difference is kept, an explanation never changes the recorded hours', ver]);
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
        (c.blockers || []).join(' | '),
        // detail the executive PDF leaves out - kept here so nothing is lost
        (c.config.shifts || []).map(function (x) { return x.name + ' ' + (x.start || '') + (x.end ? '-' + x.end : '') + ' required ' + (x.requiredHours || '—'); }).join('; '),
        (c.config.warnings || []).join('; '), c.config.overtimeMin === undefined ? '' : c.config.overtimeMin,
        ((c.staffing && c.staffing.byShift) || []).map(function (b) { return b.shift + ' ' + b.start + '-' + b.end + ': ' + b.approved + ' approved' + (b.open ? ', ' + b.open + ' open' : ''); }).join('; '),
        c.staffing ? (c.staffing.basis || '') + (c.staffing.note ? ' - ' + c.staffing.note : '') : '',
        // D4/R2: employees of this FINAL day who are excluded NOW but still counted as issued ('' for DRAFT days)
        r.status === 'FINAL' ? (r.excludedInSnapshot || 0) : '']);
    });
    var agg = (resp.aggregate || []).map(function (z) {
      return [resp.fromDate || resp.date, resp.toDate || resp.date, z.zone, z.mode, z.days, z.finalDays, z.statusDays.MATCHED, z.statusDays.UNMATCHED, z.statusDays.PENDING, z.statusDays.NO_TARGET,
        z.requiredEmployeeDays, z.approvedEmployeeDays, z.morning.required, z.morning.approved, z.night.required, z.night.approved, z.shortageDays, z.shortage, z.excessDays, z.excess,
        z.uniqueEmployees, z.records, z.hoursView ? z.hoursView.differs : z.hoursUnmatched, z.overtimeHours, z.shortHours, z.explanationsMissing, z.pendingRecords, z.disagreements, z.hoursView ? z.hoursView.approved : ''];
    });
    return [
      { name: 'Period Summary', columns: [{ header: 'From', type: 'date' }, { header: 'To', type: 'date' }, { header: 'Zone', width: 22 }, { header: 'Mode', width: 15 }, { header: 'Days', type: 'number' },
        { header: 'Final Days', type: 'number' }, { header: 'Days Matched', type: 'number' }, { header: 'Days Unmatched', type: 'number' }, { header: 'Days Pending', type: 'number' }, { header: 'Days No Target', type: 'number' },
        { header: 'Required Employee-Days', type: 'number' }, { header: 'Approved Employee-Days', type: 'number' }, { header: 'Morning Required', type: 'number' }, { header: 'Morning Approved', type: 'number' },
        { header: 'Night Required', type: 'number' }, { header: 'Night Approved', type: 'number' }, { header: 'Shortage Days', type: 'number' }, { header: 'Total Shortage', type: 'number' },
        { header: 'Excess Days', type: 'number' }, { header: 'Total Excess', type: 'number' }, { header: 'Unique Approved Employees', type: 'number' }, { header: 'Employee Records', type: 'number' },
        { header: 'Hours Different From Shift', type: 'number' }, { header: 'Overtime (H:MM)', type: 'string' }, { header: 'Short Hours (H:MM)', type: 'string' }, { header: 'Explanations Missing', type: 'number' },
        { header: 'Open Records', type: 'number' }, { header: 'Manager Disagreements', type: 'number' }, { header: 'Hours Approved', type: 'number' }],
        rows: agg.concat(agg.length ? [['', '', 'NOTE', resp.aggregationNote || 'Each day is compared with its own target; period figures are sums of daily figures (employee-days).']]
          .concat(resp.finalSnapshotExclusionsNote ? [['', '', 'NOTE', resp.finalSnapshotExclusionsNote]] : [])
          .concat(resp.exclusionsActive > 0 ? [['', '', 'NOTE', 'Employee exclusions active when generated: ' + resp.exclusionsActive + ' - excluded employees are not counted in live (DRAFT) figures; FINAL days show the issued figures.']] : []) : []) },
      { name: 'Daily Staffing', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 22 }, { header: 'City' }, { header: 'Mode', width: 15 }, { header: 'Approval Policy', width: 22 },
        { header: 'Shift', width: 13 }, { header: 'Required', type: 'number' }, { header: 'Approved', type: 'number' }, { header: 'Unresolved', type: 'number' }, { header: 'Shortage / Excess', type: 'string' },
        { header: 'Staffing Status', width: 14 }, { header: 'Unique Headcount', type: 'number' }, { header: 'Shift Coverage', type: 'number' }, { header: 'Hours Different From Shift', type: 'number' },
        { header: 'Pending / Unresolved Records', type: 'number' }, { header: 'Manager Disagreements', type: 'number' }, { header: 'Report', width: 10 }, { header: 'Snapshot', type: 'string', width: 18 },
        { header: 'Effective Expected Source', width: 22 }, { header: 'Override Status', type: 'wrap', width: 30 }, { header: 'External Approved (F)', type: 'number' }, { header: 'External Scheduled (G)', type: 'number' },
        { header: 'Plan Difference (G-F)', type: 'number' }, { header: 'Plan Check', width: 14 }, { header: 'Plan Status', width: 13 }, { header: 'Plan Source Freshness', type: 'wrap', width: 34 }, { header: 'Known Partial (G) - INCOMPLETE only', type: 'number' }, { header: 'Hours Approved', type: 'number' }], rows: summary },
      { name: 'Employee Detail', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 }, { header: 'Designation' },
        { header: 'Source', width: 22 }, { header: 'Shift' }, { header: 'Original Check-in', type: 'datetimeMin', width: 17 }, { header: 'Original Check-out', type: 'datetimeMin', width: 17 },
        { header: 'Approved Check-in', type: 'datetimeMin', width: 17 }, { header: 'Approved Check-out', type: 'datetimeMin', width: 17 }, { header: 'Time Source', width: 16 },
        { header: 'Actual Hours', type: 'string' }, { header: 'Required Hours', type: 'string' }, { header: 'Variance', type: 'string' }, { header: 'Variance (min)', type: 'number' },
        { header: 'Hours Status', width: 15 }, { header: 'Hours Reason', type: 'wrap', width: 30 }, { header: 'Hours Category', width: 14 }, { header: 'Additional Hours', type: 'string' },
        { header: 'Explanation Status', width: 14 }, { header: 'Manager Explanation(s)', type: 'wrap', width: 40 }, { header: 'Approval State', width: 14 }, { header: 'Official Decision' }, { header: 'Final Status', width: 18 },
        { header: 'Official Reviewer', width: 20 }, { header: 'Decided At', type: 'datetimeMin', width: 17 }, { header: 'Approval Policy', width: 22 }, { header: 'Manager Agreement' },
        { header: 'Manager Opinions', type: 'number' }, { header: 'Counted In Headcount' }, { header: 'Exceptions', type: 'wrap', width: 50 }, { header: 'Attendance Record ID', type: 'string', width: 24 },
        { header: 'Supplement ID', type: 'string', width: 22 }, { header: 'Manager Review ID', type: 'string', width: 38 }, { header: 'Check-in Submission ID', type: 'string', width: 22 },
        { header: 'Check-out Submission ID', type: 'string', width: 22 }, { header: 'Report', width: 10 },
        { header: 'Hours Approval', width: 28 }, { header: 'Approved / Decided By', width: 22 }, { header: 'Decided At', type: 'datetimeMin', width: 17 }, { header: 'Hours Check (computed)', width: 22 },
        { header: 'Plan Required', type: 'string' }, { header: 'Adjusted Work Time', width: 24 }], rows: detail },
      { name: 'Hours Explanations', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 },
        { header: 'Category', width: 14 }, { header: 'Required', type: 'string' }, { header: 'Actual', type: 'string' }, { header: 'Difference', type: 'string' }, { header: 'Difference When Explained', type: 'string' },
        { header: 'Explained By', width: 22 }, { header: 'Manager ID', type: 'string' }, { header: 'Role', width: 14 }, { header: 'Decision' }, { header: 'Explanation', type: 'wrap', width: 45 },
        { header: 'Recorded At', type: 'datetimeMin', width: 17 }, { header: 'Recorded By', width: 24 }, { header: 'Source', width: 30 }, { header: 'Hours Check / Display', width: 60 }, { header: 'Report', width: 10 }], rows: explRows },
      { name: 'Hours Decisions', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 },
        { header: 'Action', width: 18 }, { header: 'By', width: 22 }, { header: 'Role', width: 16 }, { header: 'At', type: 'datetimeMin', width: 17 }, { header: 'Work Time', width: 22 },
        { header: 'Required', type: 'string' }, { header: 'Actual', type: 'string' }, { header: 'Reason', type: 'wrap', width: 40 }, { header: 'Binding', width: 14 }, { header: 'Source', width: 18 }, { header: 'Report', width: 10 }], rows: hdecs },
      { name: 'Hour Differences & Cases', columns: [{ header: 'Date', type: 'date' }, { header: 'Zone', width: 20 }, { header: 'Type', width: 22 }, { header: 'Shift' }, { header: 'Employee Code', type: 'string' },
        { header: 'Employee Name', width: 26 }, { header: 'Status (display)', width: 18 }, { header: 'Detail (source, difference)', type: 'wrap', width: 70 }, { header: 'Report', width: 10 }], rows: unmatched },
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
        { header: 'Hours Tolerance (min)', type: 'number' }, { header: 'Daily Total Basis' }, { header: 'Managers', type: 'wrap', width: 40 }, { header: 'Open Blockers', type: 'wrap', width: 50 },
        { header: 'Shifts (Settings)', type: 'wrap', width: 50 }, { header: 'Settings Gaps (not invented)', type: 'wrap', width: 40 }, { header: 'Overtime From (min)', type: 'number' },
        { header: 'Approved per Area · Shift', type: 'wrap', width: 45 }, { header: 'Counting Rule', type: 'wrap', width: 50 },
        { header: 'Excluded after issue (FINAL snapshot)', type: 'number' }],
        rows: info.concat([['', 'Request', '', resp.allFinal ? 'ALL FINAL' : 'CONTAINS DRAFT', '', '', resp.generatedAt, resp.generatedBy, resp.bundleHash, '', '', '', '', '', '', '', 'Time zone: ' + resp.timeZone, '', '', '', '', '', '']]) },
    ].concat(Array.isArray(resp.unassigned) ? [
      // fingerprints whose Area has no zone: kept as recorded, never inside a zone's figures
      { name: 'Unassigned - Classification', columns: [{ header: 'Date', type: 'date' }, { header: 'Employee Code', type: 'string' }, { header: 'Employee Name', width: 26 }, { header: 'Designation' },
        { header: 'Area (as recorded)', width: 28 }, { header: 'Check-in', type: 'datetime', width: 17 }, { header: 'Check-out', type: 'datetime', width: 17 }, { header: 'Worked Hours', type: 'string' },
        { header: 'Attendance Status' }, { header: 'Review Decision' }, { header: 'Record ID', type: 'string', width: 30 }, { header: 'Needed', type: 'wrap', width: 50 }],
        rows: resp.unassigned.map(function (u) { return [u.date, u.code, u.name, u.designation, u.area || '(blank)', u.checkIn, u.checkOut, u.workedHours, u.attendanceStatus, u.decision || 'NOT ROUTED', u.recordId,
          'Classify the Area in Settings (Zone) - until then it is in no zone report and no zone headcount']; }) }] : []);
  }

  function fileName(resp) {
    var zones = (resp.reports || []).map(function (r) { return r.content.zoneId; });
    var uniq = {}; zones.forEach(function (z) { uniq[z] = true; });
    var tag = Object.keys(uniq).length === 1 ? zones[0] : (resp.zonesRequested ? (Object.keys(uniq).length ? Object.keys(uniq).length + '-ZONES' : 'UNASSIGNED') : 'ALL-ZONES');
    var period = resp.fromDate && resp.toDate && resp.fromDate !== resp.toDate ? resp.fromDate + '_to_' + resp.toDate : resp.date;
    return 'HMG_' + tag + '_' + period + '_' + (resp.allFinal ? 'FINAL' : 'DRAFT') + '_' + String(resp.bundleHash || '').slice(0, 8) + '.xlsx';
  }

  root.HMGZoneOpsExport = { workbookSheets: workbookSheets, fileName: fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HMGZoneOpsExport;
})(typeof window !== 'undefined' ? window : globalThis);
