(function () {
  'use strict';

  var BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';

  // ONLY a convenience - remembers the last date picked so a reload
  // starts on the same day. Never a source of truth for card/assignment
  // state: every render re-fetches discoverGroups from the backend, so
  // a reload or a routing change always reflects live sheet data, never
  // stale localStorage.
  var LAST_DATE_KEY = 'hmgControlLastDate';

  // Same per-person Analytics Admin credential Period Analytics already
  // uses - unlocks the Reports section here too (one admin concept, one
  // credential, reused - never a second auth system). Daily Operations/
  // Review Center above stay exactly as open as they've always been;
  // ONLY the Reports section is gated by this. Read once from the URL
  // and stripped immediately (same pattern as period-analytics.js/app.js)
  // so it never lingers in the visible address bar/history.
  var ADMIN_TOKEN = new URLSearchParams(location.search).get('adminToken') || '';
  if (new URLSearchParams(location.search).has('adminToken')) {
    history.replaceState(null, '', location.pathname);
  }

  function jsonpGet(action, params) {
    return new Promise(function (resolve, reject) {
      var cbName = 'cb_' + Math.random().toString(36).slice(2);
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true; cleanup(); reject(new Error('Request timed out'));
      }, 15000);
      function cleanup() {
        clearTimeout(timeoutId);
        delete window[cbName];
        if (scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
      }
      window[cbName] = function (data) {
        if (settled) return;
        settled = true; cleanup(); resolve(data);
      };
      var qs = 'callback=' + encodeURIComponent(cbName) + '&action=' + encodeURIComponent(action);
      Object.keys(params || {}).forEach(function (k) { qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
      var scriptEl = document.createElement('script');
      scriptEl.src = BACKEND + '?' + qs;
      scriptEl.onerror = function () {
        if (settled) return;
        settled = true; cleanup(); reject(new Error('Network error loading backend script'));
      };
      document.body.appendChild(scriptEl);
    });
  }

  // The one CONTROL-side mutation (prepare/reissue) - POST-only, through
  // the same Worker bridge as every reviewer write action, never a bare GET.
  function bridgePost(action, extra) {
    return fetch(WRITE_BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    }).then(function (r) { return r.json(); });
  }

  function setMsg(text) { document.getElementById('statusMsg').textContent = text || ''; }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function maskPhone(raw) {
    var s = String(raw == null ? '' : raw);
    return s.length > 4 ? s.slice(0, -4).replace(/./g, '*') + s.slice(-4) : s;
  }

  function normalizeSaudiPhone(raw) {
    var digits = String(raw || '').replace(/[^0-9]/g, '');
    if (digits.indexOf('00') === 0) digits = digits.slice(2);
    if (digits.indexOf('966') === 0) return digits;
    if (digits.indexOf('0') === 0) return '966' + digits.slice(1);
    if (digits.length === 9) return '966' + digits;
    return digits;
  }

  function groupLabel(card) {
    return card.reviewType === 'DOCTORS' ? 'DOCTORS' : card.zone.toUpperCase();
  }
  // City is organizational/reporting metadata only (never a routing input) -
  // Doctors spans every zone, so it shows "All Zones" in the same spot a
  // Zone card shows its city.
  function scopeLine(card) {
    return card.reviewType === 'DOCTORS' ? 'All Zones' : (card.city || '—');
  }
  function countLabel(card) {
    return card.count + (card.reviewType === 'DOCTORS' ? (card.count === 1 ? ' Doctor' : ' Doctors') : (card.count === 1 ? ' Employee' : ' Employees'));
  }
  function reviewerLabel(card) {
    return card.reviewType === 'DOCTORS' ? 'Reviewer' : 'Zone Manager';
  }

  function reload() {
    var reviewDate = document.getElementById('reviewDateInput').value;
    if (!reviewDate) return;
    try { localStorage.setItem(LAST_DATE_KEY, reviewDate); } catch (e) { /* ignore */ }
    setMsg('Loading…');
    var host = document.getElementById('cardsHost');
    while (host.firstChild) host.removeChild(host.firstChild);

    jsonpGet('discoverGroups', { reviewDate: reviewDate }).then(function (data) {
      if (!data.ok) { setMsg('Error: ' + data.error); return; }
      setMsg('');
      if (!data.cards.length) {
        host.appendChild(el('div', 'meta', 'No attendance found for this date.'));
        return;
      }
      data.cards.forEach(function (card) { host.appendChild(renderCard(card, reviewDate)); });
    }).catch(function (e) {
      setMsg('Network error: ' + e.message);
    });
  }

  function renderCard(card, reviewDate) {
    var box = el('div', 'control-card');
    box.appendChild(el('div', 'group-title', groupLabel(card)));
    box.appendChild(el('div', 'meta', scopeLine(card)));
    box.appendChild(el('div', 'meta', countLabel(card)));

    if (card.routingError) {
      box.appendChild(el('div', 'meta', reviewerLabel(card) + ': —'));
      var errLine = el('div', 'routing-error', card.routingError.indexOf('ambiguity') !== -1 ? 'Routing ambiguity' : 'Reviewer not configured');
      box.appendChild(errLine);
      return box;
    }

    box.appendChild(el('div', 'meta', reviewerLabel(card) + ': ' + card.reviewer));
    if (card.whatsapp) box.appendChild(el('div', 'meta', maskPhone(card.whatsapp)));

    var statusLine = el('div', 'status-line');
    var tag = el('span', 'tag tag-' + (card.status === 'NONE' ? 'PENDING' : card.status), card.status === 'NONE' ? 'NOT SENT' : card.status.replace('_', ' '));
    statusLine.appendChild(tag);
    box.appendChild(statusLine);

    var actions = el('div', 'row-actions');

    if (card.status === 'NONE') {
      var prepareBtn = el('button', 'btn-primary', 'Prepare');
      prepareBtn.addEventListener('click', function () { doPrepare(card, reviewDate, false, prepareBtn, box); });
      actions.appendChild(prepareBtn);
    } else if (card.status === 'EXPIRED') {
      var reissueBtn = el('button', 'btn-primary', 'Reissue');
      reissueBtn.addEventListener('click', function () { doPrepare(card, reviewDate, true, reissueBtn, box); });
      actions.appendChild(reissueBtn);
    } else if (card.status === 'COMPLETED') {
      // No send button - a completed review is done; only an explicit
      // reissue (which only applies once it expires) can reopen it.
    } else {
      // PREPARED / OPENED / IN_PROGRESS - link already exists and is
      // still valid; offer to open WhatsApp again with that same link.
      var waBtn = el('button', 'btn-primary', 'Open WhatsApp');
      waBtn.addEventListener('click', function () {
        var msg = encodeURIComponent('HMG Attendance Review — ' + reviewDate + ' · ' + groupLabel(card) + ': ' + card.managerUrl);
        window.open('https://wa.me/' + normalizeSaudiPhone(card.whatsapp) + '?text=' + msg, '_blank');
      });
      actions.appendChild(waBtn);
    }

    box.appendChild(actions);
    return box;
  }

  function doPrepare(card, reviewDate, reissue, btn, box) {
    btn.disabled = true;
    btn.textContent = reissue ? 'Reissuing…' : 'Preparing…';
    var payload = { reviewDate: reviewDate, reviewType: card.reviewType };
    if (card.reviewType === 'ZONE') payload.zone = card.zone;
    if (reissue) payload.reissue = 'true';
    bridgePost('prepareReview', payload).then(function (res) {
      if (!res.ok) {
        setMsg('Error: ' + res.error);
        btn.disabled = false;
        btn.textContent = reissue ? 'Reissue' : 'Prepare';
        return;
      }
      // Always re-render this card from a fresh backend read rather than
      // trusting the mutation response alone as UI state - the backend
      // stays the single source of truth even immediately after a write.
      reload();
    }).catch(function (e) {
      setMsg('Network error: ' + e.message);
      btn.disabled = false;
      btn.textContent = reissue ? 'Reissue' : 'Prepare';
    });
  }

  document.getElementById('reviewDateInput').addEventListener('change', reload);

  // Restore only the LAST DATE (a convenience), then always reload from
  // the backend - never assume localStorage reflects current status.
  try {
    var savedDate = localStorage.getItem(LAST_DATE_KEY);
    if (savedDate) document.getElementById('reviewDateInput').value = savedDate;
  } catch (e) { /* ignore */ }
  reload();

  // ================== REPORTS (generateV5Report bridge) ==================
  // Calls the EXISTING production V5 report generators verbatim, through
  // the same POST-only Worker bridge every mutation already uses - never
  // GET/JSONP (report generation creates a real Drive file, a side
  // effect). The Worker forwards this one action to a DIFFERENT backend
  // (production's own Apps Script, not this isolated project's) and never
  // attaches its own shared secret to it - production's authorization is
  // entirely the Analytics Admin token above, checked server-side there.
  (function initReports() {
    var authNotice = document.getElementById('reportsAuthNotice');
    var form = document.getElementById('reportsForm');
    if (!ADMIN_TOKEN) { authNotice.hidden = false; return; }
    form.hidden = false;

    // Also carries the admin token into the Period Analytics link, so
    // moving between the two modules of the same system never requires
    // re-entering/re-pasting it.
    var paLink = document.getElementById('periodAnalyticsLink');
    paLink.href = 'period-analytics.html?adminToken=' + encodeURIComponent(ADMIN_TOKEN);

    var typeSel = document.getElementById('reportType');
    var dateField = document.getElementById('reportDateField');
    var fromField = document.getElementById('reportFromField');
    var toField = document.getElementById('reportToField');
    var designationField = document.getElementById('reportDesignationField');
    var cityInput = document.getElementById('reportCity');
    var designationInput = document.getElementById('reportDesignation');

    function onTypeChange() {
      var isAttendance = typeSel.value === 'ATTENDANCE';
      dateField.hidden = !isAttendance;
      fromField.hidden = isAttendance;
      toField.hidden = isAttendance;
      designationField.hidden = isAttendance;
    }
    typeSel.addEventListener('change', onTypeChange);
    onTypeChange();

    function setReportMsg(text) { document.getElementById('reportStatusMsg').textContent = text || ''; }

    function renderReportFiles(files, host) {
      if (!files || !files.length) { host.appendChild(el('div', 'meta', 'No files were generated.')); return; }
      files.forEach(function (f) {
        var box = el('div', 'control-card');
        box.appendChild(el('div', 'meta', (f.city || '') + (f.date ? ' · ' + f.date : '') + (f.period ? ' · ' + f.period : '')));
        if (f.pdfUrl) {
          var pdfLink = document.createElement('a');
          pdfLink.href = f.pdfUrl; pdfLink.target = '_blank'; pdfLink.rel = 'noopener'; pdfLink.textContent = 'Open Report';
          box.appendChild(pdfLink);
        }
        if (f.url) {
          box.appendChild(document.createTextNode(' '));
          var driveLink = document.createElement('a');
          driveLink.href = f.url; driveLink.target = '_blank'; driveLink.rel = 'noopener'; driveLink.textContent = 'Open in Drive';
          box.appendChild(driveLink);
        }
        host.appendChild(box);
      });
    }

    // Typical observed generation durations, used ONLY to drive a client-
    // side progress ESTIMATE - never a real backend signal (the backend
    // has no progress-reporting mechanism, and this bridge is intentionally
    // a single request/response with nothing in between). Deliberately
    // conservative; the curve below keeps creeping forward past this
    // point rather than freezing, so a slower-than-usual run never reads
    // as stuck.
    var REPORT_ESTIMATED_SECONDS = { ATTENDANCE: 50, EMPLOYEE_HOURS: 60 };
    var REPORT_STAGES = ['Preparing data', 'Building report', 'Saving report', 'Finalizing'];

    function stageForProgress(pct) {
      if (pct < 25) return REPORT_STAGES[0];
      if (pct < 70) return REPORT_STAGES[1];
      if (pct < 92) return REPORT_STAGES[2];
      return REPORT_STAGES[3];
    }

    // Asymptotic curve - rises quickly at first, then slows, but never
    // fully stops (always keeps inching toward, and just under, 96%) even
    // well past the typical duration, so it never visibly sits frozen at
    // one number while the request is still genuinely in flight.
    function estimatedProgressPct(elapsedMs, estimatedMs) {
      var ratio = elapsedMs / estimatedMs;
      return Math.min(96, (1 - Math.exp(-1.1 * ratio)) * 96);
    }

    function buildProgressPanel(titleText) {
      var host = document.getElementById('reportResults');
      host.innerHTML = '';
      var panel = el('div', 'control-card');
      var title = el('div', 'group-title', titleText);
      var barOuter = el('div', 'progress-bar-outer');
      var barInner = el('div', 'progress-bar-inner');
      barOuter.appendChild(barInner);
      var pctText = el('div', 'progress-pct', '0%');
      var stageText = el('div', 'meta', 'Current stage: ' + REPORT_STAGES[0]);
      var etaText = el('div', 'meta', 'Estimated time remaining: calculating…');
      var note = el('div', 'meta progress-estimate-note', 'Percentage and time remaining are estimates based on typical report durations, not exact backend progress.');
      panel.appendChild(title);
      panel.appendChild(barOuter);
      panel.appendChild(pctText);
      panel.appendChild(stageText);
      panel.appendChild(etaText);
      panel.appendChild(note);
      host.appendChild(panel);
      return { host: host, panel: panel, title: title, barInner: barInner, pctText: pctText, stageText: stageText, etaText: etaText };
    }

    function generateReport() {
      var btn = document.getElementById('generateReportBtn');
      btn.disabled = true;
      btn.textContent = 'Generating…';
      setReportMsg('');

      var reportTypeLabel = typeSel.value === 'ATTENDANCE' ? 'Attendance Report' : 'Employee Hours Report';
      var estimatedMs = (REPORT_ESTIMATED_SECONDS[typeSel.value] || 55) * 1000;
      var startTime = Date.now();
      var slowNoticeShown = false;
      var ui = buildProgressPanel('Generating ' + reportTypeLabel);

      var tickHandle = setInterval(function () {
        var elapsed = Date.now() - startTime;
        var pct = estimatedProgressPct(elapsed, estimatedMs);
        ui.barInner.style.width = pct.toFixed(0) + '%';
        ui.pctText.textContent = pct.toFixed(0) + '%';
        ui.stageText.textContent = 'Current stage: ' + stageForProgress(pct);
        var remainingMs = estimatedMs - elapsed;
        ui.etaText.textContent = remainingMs > 1500
          ? 'Estimated time remaining: ~' + Math.round(remainingMs / 1000) + ' seconds'
          : 'Estimated time remaining: finishing up…';
        // A soft cue only - the request is still genuinely in flight, this
        // is not a failure state and nothing here retries or cancels it.
        if (elapsed > estimatedMs * 1.6 && !slowNoticeShown) {
          slowNoticeShown = true;
          setReportMsg('Still working - this report is taking a bit longer than usual.');
        }
      }, 400);

      var payload = {
        reportBridgeToken: ADMIN_TOKEN,
        reportType: typeSel.value,
        city: cityInput.value.trim() || 'ALL_CITIES',
        cityMode: document.getElementById('reportCityMode').value,
      };
      if (typeSel.value === 'ATTENDANCE') {
        payload.dateStr = document.getElementById('reportDate').value;
      } else {
        payload.fromStr = document.getElementById('reportFrom').value;
        payload.toStr = document.getElementById('reportTo').value;
        if (designationInput.value.trim()) payload.designation = designationInput.value.trim();
      }

      bridgePost('generateV5Report', payload).then(function (res) {
        clearInterval(tickHandle);
        btn.disabled = false;
        btn.textContent = 'Generate Report';
        setReportMsg('');

        if (!res.ok) {
          // A real, confirmed backend response - the backend itself says
          // this did not succeed, so a definitive failure state is
          // accurate here (unlike the network-level case in .catch below).
          ui.host.innerHTML = '';
          ui.host.appendChild(el('div', 'meta report-error', 'Error: ' + res.error));
          return;
        }

        var elapsedSec = Math.round((Date.now() - startTime) / 1000);
        ui.title.textContent = reportTypeLabel + ' Ready';
        ui.barInner.style.width = '100%';
        ui.pctText.textContent = '100% ✓';
        ui.stageText.textContent = 'Completed in ' + elapsedSec + ' seconds';
        ui.etaText.textContent = '';
        renderReportFiles(res.files, ui.host);
      }).catch(function () {
        clearInterval(tickHandle);
        btn.disabled = false;
        btn.textContent = 'Generate Report';
        setReportMsg('');
        // A network-level failure (e.g. the Worker/browser relay timing
        // out) is NOT proof the backend failed - production may already
        // have created the real Drive file by the time this rejects.
        // Never claim a definitive failure here, and never auto-retry
        // (that could create a duplicate report) - the user decides when
        // to check Reports or try again.
        ui.host.innerHTML = '';
        ui.host.appendChild(el('div', 'meta report-slow-notice',
          'Report generation is taking longer than usual. It may still be completing in Drive. Please check Reports shortly before trying again.'));
      });
    }
    document.getElementById('generateReportBtn').addEventListener('click', generateReport);

    // City/Designation are free-text (not a live dropdown) - this
    // isolated project has no access to production's real configured-
    // city/designation list without another new bridge beyond this
    // phase's approved scope, so the backend's own strict server-side
    // check (against listConfiguredCities_()/listDistinctDesignations_())
    // is the actual validation; a typo just returns a clear "Unknown
    // city/designation" error rather than silently guessing.
  })();
})();
