(function () {
  'use strict';

  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';

  // The bridge secret is NEVER known to this page - periodAnalytics is a
  // sensitive-data read, so (unlike discoverGroups/getData) it is routed
  // through the SAME POST-only, secret-gated Worker bridge every write
  // action already uses, never a bare public GET/JSONP with a secret
  // embedded in this file.
  function bridgePost(action, extra) {
    return fetch(WRITE_BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    }).then(function (r) { return r.json(); });
  }

  // REAL per-person Period Analytics credential (2026-09-09) - a
  // completely separate value from a manager's review token or the
  // Worker's own shared secret; this page never sees either of those.
  // Read once from the URL, then stripped from the visible address bar/
  // history immediately (same pattern app.js already uses for the
  // reviewer token) so it never lingers in a screenshot, browser history,
  // or a copy-pasted URL's visible query string. Kept only in this
  // in-memory variable for the rest of the page's life; a reload starts
  // over and requires the token again - this page has no "remember me".
  var ADMIN_TOKEN = new URLSearchParams(location.search).get('adminToken') || '';
  if (new URLSearchParams(location.search).has('adminToken')) {
    history.replaceState(null, '', location.pathname);
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function td(text) { return el('td', null, text === null || text === undefined || text === '' ? '—' : String(text)); }

  function setMsg(text) { document.getElementById('statusMsg').textContent = text || ''; }

  function statBox(label, value) {
    var box = el('div', 'stat-box');
    box.appendChild(el('div', 'stat-value', String(value)));
    box.appendChild(el('div', 'stat-label', label));
    return box;
  }

  function fillSelect(select, values, currentVal) {
    var placeholder = select.options[0];
    select.innerHTML = '';
    select.appendChild(placeholder);
    values.forEach(function (v) {
      if (!v) return;
      var opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;
  }

  var lastData = null;
  var lateSortKey = 'occurrences';

  function renderAttendanceSummary(s) {
    document.getElementById('attUnitNote').textContent =
      'Metrics below are ATTENDANCE ROWS (~one employee-day record each) unless labeled "distinct employees". ' +
      s.distinctEmployees + ' distinct employees across ' + s.totalRecords + ' rows.' +
      (s.unmappedCity ? ' ' + s.unmappedCity + ' row(s) have no City mapping (shown as unmapped, never guessed).' : '');
    var host = document.getElementById('attStats');
    host.innerHTML = '';
    [
      ['Total Records', s.totalRecords], ['Distinct Employees', s.distinctEmployees],
      ['On Time', s.onTime], ['Late 15+', s.late15], ['Late 30+', s.late30], ['Total Late', s.totalLate],
      ['Missing Check-in', s.missingCheckin], ['Missing Check-out', s.missingCheckout],
      ['Needs Review', s.needsReview], ['Unmatched', s.unmatched], ['Complete', s.complete],
      ['Total Worked', s.totalWorkedHoursLabel],
    ].forEach(function (pair) { host.appendChild(statBox(pair[0], pair[1])); });
  }

  function renderManagerSummary(s) {
    var host = document.getElementById('mgrStats');
    host.innerHTML = '';
    [
      ['Total Assigned', s.totalAssigned], ['Total Completed', s.totalCompleted], ['Total In Progress', s.totalInProgress],
      ['Total Pending', s.totalPending], ['Total Expired', s.totalExpired], ['Completion %', s.completionPct + '%'],
      ['Total Approved', s.totalApproved], ['Total Modified', s.totalModified], ['Total Rejected', s.totalRejected],
      ['Avg Completion (min)', s.avgCompletionMinutes === null ? '—' : s.avgCompletionMinutes],
    ].forEach(function (pair) { host.appendChild(statBox(pair[0], pair[1])); });
  }

  function rankCard(title, r, unit) {
    var box = el('div', 'rank-card');
    box.appendChild(el('div', 'rank-title', title));
    if (!r) { box.appendChild(el('div', 'rank-sample', 'No qualifying data in this period.')); return box; }
    box.appendChild(el('div', 'rank-value', r.reviewerName + ' (' + r.scope + ')'));
    box.appendChild(el('div', 'rank-sample', r.value + (unit || '') + ' — sample size ' + r.sampleSize));
    return box;
  }

  function renderRankings(r) {
    var host = document.getElementById('rankCards');
    host.innerHTML = '';
    host.appendChild(rankCard('Highest Completion %', r.highestCompletionPct, '%'));
    host.appendChild(rankCard('Most Expired / Not Reviewed', r.mostExpired, ' expired'));
    host.appendChild(rankCard('Fastest Avg Completion', r.fastestAvgCompletion, ' min'));
    host.appendChild(rankCard('Most Modifications', r.mostModifications, ' modified'));
    host.appendChild(rankCard('Most Rejections', r.mostRejections, ' rejected'));
  }

  function renderManagerTable(rows) {
    var body = document.getElementById('mgrTableBody');
    body.innerHTML = '';
    if (!rows.length) { body.appendChild(el('tr')).appendChild(el('td', 'empty-note', 'No assignments match the current filters.')).colSpan = 18; return; }
    rows.forEach(function (m) {
      var tr = el('tr');
      // avgOpenToSubmitMinutesExact/Approx are two DISTINCT fields from
      // the backend, never blended - Approx is only ever populated for
      // legacy rows that predate the true First Opened At column, and is
      // rendered in its own clearly-labeled "APPROX (legacy)" column so
      // it's never mistaken for the exact figure.
      [m.reviewerName, m.reviewType, m.scope, m.city, m.assigned, m.completed, m.inProgress, m.pending, m.expired,
       m.reissued, m.completionPct + '%', m.approvedCount, m.modifiedCount, m.rejectedCount,
       m.avgOpenToSubmitMinutesExact, m.avgOpenToSubmitMinutesApprox, m.avgCreateToSubmitMinutes, m.lastCompletedDate]
        .forEach(function (v) { tr.appendChild(td(v)); });
      body.appendChild(tr);
    });
  }

  function renderTopLate() {
    var body = document.getElementById('topLateTableBody');
    body.innerHTML = '';
    var rows = (lastData.lateEmployees || []).slice().sort(function (a, b) { return b[lateSortKey] - a[lateSortKey]; });
    if (!rows.length) { var tr0 = el('tr'); var td0 = el('td', 'empty-note', 'No late occurrences in this period.'); td0.colSpan = 7; tr0.appendChild(td0); body.appendChild(tr0); return; }
    rows.forEach(function (e) {
      var tr = el('tr');
      var zones = e.byZoneEvent.map(function (z) { return z.zone; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ');
      [e.employeeName, e.employeeCode, e.designation, zones, e.occurrences, e.totalLateMinutes, e.maxLateMinutes]
        .forEach(function (v) { tr.appendChild(td(v)); });
      body.appendChild(tr);
    });
  }

  function renderLateDetailGroups() {
    var host = document.getElementById('lateDetailGroups');
    host.innerHTML = '';
    var rows = lastData.lateEmployees || [];
    if (!rows.length) { host.appendChild(el('div', 'empty-note', 'No late occurrences in this period.')); return; }
    rows.forEach(function (e) {
      var details = document.createElement('details');
      details.className = 'detail-group';
      var summary = document.createElement('summary');
      summary.textContent = e.employeeName + ' (#' + e.employeeCode + ', ' + e.designation + ') — ' +
        e.occurrences + ' occurrence(s), ' + e.totalLateMinutes + ' total late min, avg ' + e.averageLateMinutes + ' min, max ' + e.maxLateMinutes + ' min';
      details.appendChild(summary);
      var scroll = el('div', 'table-scroll');
      var table = document.createElement('table');
      table.className = 'data-table';
      var thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Zone</th><th>Event</th><th>City</th><th>Occurrences</th><th>Total Late Min</th></tr>';
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      e.byZoneEvent.forEach(function (z) {
        var tr = el('tr');
        [z.zone, z.event, z.city, z.occurrences, z.totalLateMinutes].forEach(function (v) { tr.appendChild(td(v)); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroll.appendChild(table);
      details.appendChild(scroll);
      details.appendChild(el('div', 'meta', 'Dates: ' + e.dates.join(', ')));
      host.appendChild(details);
    });
  }

  function renderDecisions(rows) {
    var body = document.getElementById('decisionTableBody');
    body.innerHTML = '';
    if (!rows.length) { var tr0 = el('tr'); var td0 = el('td', 'empty-note', 'No decisions in this period.'); td0.colSpan = 9; tr0.appendChild(td0); body.appendChild(tr0); return; }
    rows.forEach(function (d) {
      var tr = el('tr');
      [d.date, d.zone, d.event, d.employeeName, d.employeeCode, d.designation, d.decision, d.reviewer, d.revision]
        .forEach(function (v) { tr.appendChild(td(v)); });
      body.appendChild(tr);
    });
  }

  function populateFilterOptions(data) {
    var zones = {}, cities = {}, reviewers = {};
    (data.managerPerformance || []).forEach(function (m) { if (m.scope && m.reviewType === 'ZONE') zones[m.scope] = true; if (m.city) cities[m.city] = true; reviewers[m.reviewerName] = true; });
    fillSelect(document.getElementById('zoneFilter'), Object.keys(zones).sort(), document.getElementById('zoneFilter').value);
    fillSelect(document.getElementById('cityFilter'), Object.keys(cities).sort(), document.getElementById('cityFilter').value);
    // Period Report's own City/Zone dropdowns - filled from the same
    // Load() response rather than a second lookup call.
    fillSelect(document.getElementById('prCity'), Object.keys(cities).sort(), document.getElementById('prCity').value);
    fillSelect(document.getElementById('prZone'), Object.keys(zones).sort(), document.getElementById('prZone').value);
  }

  function load() {
    // Client-side gate is a UX convenience ONLY - the real authorization
    // boundary is entirely server-side (Code.gs's
    // validateAnalyticsAdminToken_, checked before any data is computed
    // or returned). A forged/blank token here still gets the exact same
    // "Not authorized" response from the backend as if this check didn't
    // exist at all.
    if (!ADMIN_TOKEN) { setMsg('Access token required - open this page using your Period Analytics access link.'); return; }
    var fromDate = document.getElementById('fromDate').value;
    var toDate = document.getElementById('toDate').value;
    if (!fromDate || !toDate) { setMsg('Pick both a From and To date.'); return; }
    setMsg('Loading…');
    document.getElementById('resultsHost').hidden = true;
    document.getElementById('loadBtn').disabled = true;

    var payload = {
      fromDate: fromDate, toDate: toDate, adminToken: ADMIN_TOKEN,
      includeTest: document.getElementById('includeTest').checked ? 'true' : 'false',
      zone: document.getElementById('zoneFilter').value,
      city: document.getElementById('cityFilter').value,
      designation: document.getElementById('designationFilter').value,
      reviewType: document.getElementById('reviewTypeFilter').value,
      attendanceStatus: document.getElementById('attendanceStatusFilter').value,
      decision: document.getElementById('decisionFilter').value,
      reviewer: document.getElementById('reviewerFilter').value,
    };
    Object.keys(payload).forEach(function (k) { if (payload[k] === '' || payload[k] === undefined) delete payload[k]; });

    bridgePost('periodAnalytics', payload).then(function (data) {
      document.getElementById('loadBtn').disabled = false;
      if (!data.ok) { setMsg('Error: ' + data.error); return; }
      setMsg('');
      lastData = data;
      populateFilterOptions(data);
      renderAttendanceSummary(data.attendanceSummary);
      renderManagerSummary(data.managerSummary);
      renderRankings(data.rankings);
      renderManagerTable(data.managerPerformance);
      renderTopLate();
      renderLateDetailGroups();
      renderDecisions(data.reviewDecisions);
      document.getElementById('resultsHost').hidden = false;
    }).catch(function (e) {
      document.getElementById('loadBtn').disabled = false;
      setMsg('Network error: ' + e.message);
    });
  }

  document.getElementById('loadBtn').addEventListener('click', load);
  document.getElementById('lateRankBy').addEventListener('change', function () {
    lateSortKey = this.value;
    if (lastData) renderTopLate();
  });

  // Default range: last 7 days ending today - a sensible starting point,
  // never auto-loaded (the owner still presses Load, same pattern as the
  // Control Center's own date picker).
  (function setDefaultDates() {
    var today = new Date();
    var weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    function iso(d) { return d.toISOString().slice(0, 10); }
    document.getElementById('toDate').value = iso(today);
    document.getElementById('fromDate').value = iso(weekAgo);
  })();

  // ================== PERIOD REPORT (PDF / Excel) ==================
  // Stays under the SAME Analytics Admin token as the rest of this page -
  // deliberately NOT exposed from the employee Control Center. Both
  // buttons POST to production (via this same secret-gated Worker
  // bridge, postToProduction branch) and reuse the exact progress-bar/
  // ETA pattern already approved for report generation and Data Sync.
  (function initPeriodReport() {
    (function setDefaultDates() {
      var today = new Date();
      var weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
      function iso(d) { return d.toISOString().slice(0, 10); }
      document.getElementById('prToDate').value = iso(today);
      document.getElementById('prFromDate').value = iso(weekAgo);
    })();

    var resultHost = document.getElementById('prResult');
    function setPrMsg(text) { document.getElementById('prStatusMsg').textContent = text || ''; }

    var PERIOD_REPORT_STAGES = ['Preparing data', 'Calculating manager performance', 'Calculating attendance metrics', 'Building report', 'Saving report', 'Finalizing'];
    function stageForPeriodProgress(pct) {
      if (pct < 12) return PERIOD_REPORT_STAGES[0];
      if (pct < 35) return PERIOD_REPORT_STAGES[1];
      if (pct < 55) return PERIOD_REPORT_STAGES[2];
      if (pct < 80) return PERIOD_REPORT_STAGES[3];
      if (pct < 94) return PERIOD_REPORT_STAGES[4];
      return PERIOD_REPORT_STAGES[5];
    }
    function estimatedPeriodProgressPct(elapsedMs, estimatedMs) {
      var ratio = elapsedMs / estimatedMs;
      return Math.min(96, (1 - Math.exp(-1.1 * ratio)) * 96);
    }

    function generatePeriodReport(format) {
      if (!ADMIN_TOKEN) { setPrMsg('Access token required - open this page using your Period Analytics access link.'); return; }
      var fromStr = document.getElementById('prFromDate').value;
      var toStr = document.getElementById('prToDate').value;
      if (!fromStr || !toStr) { setPrMsg('Pick both a From and To date.'); return; }

      var pdfBtn = document.getElementById('prGeneratePdfBtn');
      var excelBtn = document.getElementById('prGenerateExcelBtn');
      pdfBtn.disabled = true; excelBtn.disabled = true;
      var activeBtn = format === 'pdf' ? pdfBtn : excelBtn;
      activeBtn.textContent = format === 'pdf' ? 'Generating PDF…' : 'Generating Excel…';
      setPrMsg('');

      var reportLabel = format === 'pdf' ? 'PDF' : 'Excel';
      // Excel (a spreadsheet write per section) has run consistently
      // faster than the Slides-based PDF in practice - separate estimates
      // keep the ETA honest for each format rather than one shared guess.
      var estimatedSeconds = format === 'pdf' ? 45 : 30;
      var startTime = Date.now();
      resultHost.innerHTML = '';
      var panel = el('div', 'control-card');
      var title = el('div', 'group-title', 'Generating Period Report (' + reportLabel + ')');
      var barOuter = el('div', 'progress-bar-outer');
      var barInner = el('div', 'progress-bar-inner');
      barOuter.appendChild(barInner);
      var pctText = el('div', 'progress-pct', '0%');
      var stageText = el('div', 'meta', 'Current stage: ' + PERIOD_REPORT_STAGES[0]);
      var timeText = el('div', 'meta', 'Elapsed: 0 sec');
      var note = el('div', 'meta progress-estimate-note', 'Percentage and time remaining are estimates based on typical report durations, not exact backend progress.');
      panel.appendChild(title); panel.appendChild(barOuter); panel.appendChild(pctText);
      panel.appendChild(stageText); panel.appendChild(timeText); panel.appendChild(note);
      resultHost.appendChild(panel);

      var tickHandle = setInterval(function () {
        var elapsedMs = Date.now() - startTime;
        var pct = estimatedPeriodProgressPct(elapsedMs, estimatedSeconds * 1000);
        barInner.style.width = pct.toFixed(0) + '%';
        pctText.textContent = pct.toFixed(0) + '%';
        stageText.textContent = 'Current stage: ' + stageForPeriodProgress(pct);
        var elapsedSec = Math.round(elapsedMs / 1000);
        var remainingMs = estimatedSeconds * 1000 - elapsedMs;
        timeText.textContent = 'Elapsed: ' + elapsedSec + ' sec' +
          (remainingMs > 1500 ? ' · Estimated remaining: ~' + Math.round(remainingMs / 1000) + ' sec' : ' · finishing up…');
      }, 400);

      var payload = {
        reportBridgeToken: ADMIN_TOKEN, fromStr: fromStr, toStr: toStr,
        city: document.getElementById('prCity').value, zone: document.getElementById('prZone').value,
        reviewType: document.getElementById('prReviewType').value,
      };

      bridgePost(format === 'pdf' ? 'generatePeriodReportPdf' : 'generatePeriodReportExcel', payload).then(function (res) {
        clearInterval(tickHandle);
        pdfBtn.disabled = false; excelBtn.disabled = false;
        pdfBtn.textContent = 'Generate PDF'; excelBtn.textContent = 'Generate Excel';
        var elapsedSec = Math.round((Date.now() - startTime) / 1000);

        if (!res.ok) {
          resultHost.innerHTML = '';
          resultHost.appendChild(el('div', 'meta report-error', 'Error: ' + res.error));
          return;
        }

        resultHost.innerHTML = '';
        var doneBox = el('div', 'control-card');
        doneBox.appendChild(el('div', 'group-title', 'Period Report Ready ✓'));
        doneBox.appendChild(el('div', 'meta', 'Period: ' + fromStr + ' → ' + toStr));
        var linkLine = el('div', 'meta');
        if (format === 'pdf') {
          linkLine.appendChild(document.createTextNode('PDF: '));
          var pdfLink = document.createElement('a');
          pdfLink.href = res.pdfUrl; pdfLink.target = '_blank'; pdfLink.rel = 'noopener'; pdfLink.textContent = 'Open';
          linkLine.appendChild(pdfLink);
          linkLine.appendChild(document.createTextNode(' · '));
          var slidesLink = document.createElement('a');
          slidesLink.href = res.url; slidesLink.target = '_blank'; slidesLink.rel = 'noopener'; slidesLink.textContent = 'Open Slides source';
          linkLine.appendChild(slidesLink);
        } else {
          linkLine.appendChild(document.createTextNode('Excel: '));
          var excelLink = document.createElement('a');
          excelLink.href = res.excelUrl; excelLink.target = '_blank'; excelLink.rel = 'noopener'; excelLink.textContent = 'Download';
          linkLine.appendChild(excelLink);
          linkLine.appendChild(document.createTextNode(' · '));
          var sheetLink = document.createElement('a');
          sheetLink.href = res.url; sheetLink.target = '_blank'; sheetLink.rel = 'noopener'; sheetLink.textContent = 'Open in Sheets';
          linkLine.appendChild(sheetLink);
        }
        doneBox.appendChild(linkLine);
        doneBox.appendChild(el('div', 'meta', 'Completed in: ' + elapsedSec + ' sec'));
        resultHost.appendChild(doneBox);
      }).catch(function () {
        clearInterval(tickHandle);
        pdfBtn.disabled = false; excelBtn.disabled = false;
        pdfBtn.textContent = 'Generate PDF'; excelBtn.textContent = 'Generate Excel';
        resultHost.innerHTML = '';
        resultHost.appendChild(el('div', 'meta report-slow-notice',
          'Could not confirm the report finished. It may still be completing - check back shortly rather than generating again.'));
      });
    }

    document.getElementById('prGeneratePdfBtn').addEventListener('click', function () { generatePeriodReport('pdf'); });
    document.getElementById('prGenerateExcelBtn').addEventListener('click', function () { generatePeriodReport('excel'); });
  })();

  // UX-only early notice (see the real check inside load()) - just tells
  // a visitor with no token why nothing will happen before they even
  // click Load, and keeps the filter bar visibly present with zero data
  // ever fetched or shown, satisfying "the URL alone provides zero data".
  if (!ADMIN_TOKEN) {
    setMsg('Access token required - open this page using your Period Analytics access link. No data is available without it.');
    document.getElementById('loadBtn').disabled = true;
    document.getElementById('prGeneratePdfBtn').disabled = true;
    document.getElementById('prGenerateExcelBtn').disabled = true;
  }
})();
