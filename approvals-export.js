// Zone Manager approvals report -> Excel workbook layout (2026-10-14).
// Pure functions only: turns the backend's approvals report (the SAME response
// the page shows) into sheet definitions for HMGXlsx.build, so the file can
// never disagree with the on-screen report. No token or phone number exists in
// the response, so none can reach the file.
(function (root) {
  'use strict';

  var DETAIL_TYPES = {
    'Work Date': 'date', 'Employee Code': 'string', 'Scheduled Start': 'time', 'Check-in': 'datetimeMin', 'Check-out': 'datetimeMin',
    'Late Minutes': 'number', 'Employee Code Override': 'string', 'Check-in Override': 'datetimeMin', 'Check-out Override': 'datetimeMin',
    'Decision Revision': 'number', 'Decided At': 'datetime', 'Link Created At': 'datetime', 'First Opened At': 'datetime', 'Final Submitted At': 'datetime',
    'Manager Review ID': 'string', 'Attendance Record ID': 'string', 'Check-in Submission ID': 'string', 'Check-out Submission ID': 'string',
    'Manager Comment / Reason': 'wrap', 'Data Note': 'wrap', 'Assignment ID': 'string',
  };
  var DETAIL_WIDTHS = {
    'Work Date': 12, 'Zone': 22, 'Event / Area': 28, 'Employee Name': 28, 'Check-in': 17, 'Check-out': 17, 'Approval Status': 15, 'Final Status': 18,
    'Manager Comment / Reason': 36, 'Decided At': 20, 'Zone Manager': 22, 'Review Period': 24, 'Assignment ID': 44, 'Link Created At': 20,
    'First Opened At': 20, 'Final Submitted At': 20, 'Manager Review ID': 38, 'Attendance Record ID': 24, 'Data Note': 40,
  };

  var STATUS_HELP = [
    ['APPROVED', 'The Zone Manager approved the record as recorded by the system.'],
    ['MODIFIED', 'Approved as an exception (Final Status "Approved Exception"); the reason is in Manager Comment / Reason.'],
    ['REJECTED', 'The Zone Manager rejected the record; the reason is in Manager Comment / Reason.'],
    ['PENDING', 'Covered by a review link that is still live, no decision yet.'],
    ['NOT_REVIEWED', 'Covered by a review link that expired / was revoked / was submitted without a decision for this record.'],
  ];

  function filterLabel(f) {
    var parts = [];
    if (f.zone) parts.push('Zone = ' + f.zone);
    if (f.city) parts.push('City = ' + f.city);
    if (f.reviewer) parts.push('Zone Manager = ' + f.reviewer);
    if (f.status) parts.push('Approval Status = ' + f.status);
    if (f.employee) parts.push('Employee contains "' + f.employee + '"');
    if (f.reviewType) parts.push('Review Type = ' + f.reviewType);
    if (f.assignmentId) parts.push('Review Period (link) = ' + f.assignmentId);
    return parts.length ? parts.join('; ') : 'None (all records in the date range)';
  }

  function workbookSheets(rep) {
    var s = rep.summary, l = s.links || {};
    var summaryRows = [
      ['Report', 'HMG Zone Manager Approvals Report'],
      ['Date range (work dates)', rep.fromDate + ' to ' + rep.toDate],
      ['Filters', filterLabel(rep.filters || {})],
      ['Test data included', rep.includeTest ? 'Yes' : 'No'],
      ['Generated at', rep.generatedAt],
      ['Time zone of all dates and times', rep.timeZone],
      ['', ''],
      ['TOTALS (records = employee-days)', ''],
      ['Total records', s.totalRecords], ['Approved', s.approved], ['Modified', s.modified], ['Rejected', s.rejected],
      ['Decided (approved + modified + rejected)', s.decided], ['Pending', s.pending], ['Not reviewed', s.notReviewed],
      ['Records in submitted (completed) reviews', s.recordsInSubmittedReviews], ['Distinct employees', s.employees],
      ['', ''],
      ['REVIEW LINKS', ''],
      ['Review links', l.total], ['Completed (final submitted)', l.completed], ['In progress', l.inProgress], ['Opened, no decision yet', l.opened],
      ['Sent, not opened', l.prepared], ['Expired', l.expired], ['Revoked', l.revoked],
      ['', ''],
      ['DATA QUALITY (nothing is hidden - every decision row is listed)', ''],
      ['Duplicate decision rows', s.duplicateDecisionRows], ['Decisions without a matching review link', s.decisionsWithoutLink],
      ['Decisions without a matching attendance row', s.decisionsWithoutAttendance], ['Unrecognised decision values', s.otherDecision],
      ['Test records excluded', s.excludedTestRecords],
      ['', ''],
      ['STATUS DEFINITIONS', ''],
    ].concat(STATUS_HELP).concat([
      ['', ''],
      ['Source', 'Manager_Review (decisions), Daily_Attendance (original attendance), Review_Tokens (review links) - read live; no review link token is included.'],
    ]);
    return [
      { name: 'Summary', columns: [{ header: 'Item', width: 46 }, { header: 'Value', width: 90, type: 'wrap' }], rows: summaryRows },
      { name: 'By Zone Manager', columns: [
        { header: 'Zone Manager', width: 26 }, { header: 'Review Type', width: 14 }, { header: 'Zones', width: 36 }, { header: 'Review Links', type: 'number' },
        { header: 'Submitted Links', type: 'number' }, { header: 'Records', type: 'number' }, { header: 'Approved', type: 'number' }, { header: 'Modified', type: 'number' },
        { header: 'Rejected', type: 'number' }, { header: 'Pending', type: 'number' }, { header: 'Not Reviewed', type: 'number' }],
        rows: (rep.reviewers || []).map(function (r) { return [r.reviewer, r.reviewTypes, r.zones, r.links, r.submittedLinks, r.records, r.approved, r.modified, r.rejected, r.pending, r.notReviewed]; }) },
      { name: 'Review Links', columns: [
        { header: 'Assignment ID', width: 44, type: 'string' }, { header: 'Review Type', width: 12 }, { header: 'Zone / Scope', width: 22 }, { header: 'City', width: 12 },
        { header: 'Zone Manager', width: 22 }, { header: 'Period Start', type: 'date', width: 12 }, { header: 'Period End', type: 'date', width: 12 }, { header: 'Days', type: 'number' },
        { header: 'Link Status', width: 14 }, { header: 'Link Revision', type: 'number' }, { header: 'Created At', type: 'datetime', width: 20 },
        { header: 'Expires At', type: 'datetime', width: 20 }, { header: 'First Opened At', type: 'datetime', width: 20 }, { header: 'Final Submitted At', type: 'datetime', width: 20 },
        { header: 'Records', type: 'number' }, { header: 'Approved', type: 'number' }, { header: 'Modified', type: 'number' }, { header: 'Rejected', type: 'number' },
        { header: 'Pending', type: 'number' }, { header: 'Not Reviewed', type: 'number' }],
        rows: (rep.links || []).map(function (k) {
          return [k.assignmentId, k.reviewType, k.scope, k.city, k.reviewer, k.periodStart, k.periodEnd, k.days, k.status, k.revision, k.createdAt, k.expiresAt,
            k.firstOpenedAt, k.submittedAt, k.records, k.approved, k.modified, k.rejected, k.pending, k.notReviewed];
        }) },
      { name: 'Approval Details', columns: rep.columns.map(function (h) { return { header: h, type: DETAIL_TYPES[h] || 'text', width: DETAIL_WIDTHS[h] }; }), rows: rep.rows },
    ];
  }

  function fileName(rep, now) {
    var f = rep.filters || {};
    var tag = [f.zone, f.reviewer, f.status, f.reviewType].filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60);
    var stamp = String(rep.generatedAt || '').replace(/[^0-9]/g, '').slice(0, 12);
    return 'HMG_Zone_Manager_Approvals_' + rep.fromDate + '_to_' + rep.toDate + (tag ? '_' + tag : '') + (stamp ? '_' + stamp : '') + '.xlsx';
  }

  root.HMGApprovalsExport = { workbookSheets: workbookSheets, fileName: fileName, filterLabel: filterLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HMGApprovalsExport;
})(typeof window !== 'undefined' ? window : globalThis);
