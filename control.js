(function () {
  'use strict';

  var BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';


  // PERMANENT per-person Period Analytics credential (the "master key")
  // - this page never validates it itself, only forwards it into the
  // Period Analytics link below, for THIS page load only.
  //
  // 2026-09-13 (device-credential redesign): NEVER persisted here, not
  // even in sessionStorage - the permanent admin token must not live in
  // the browser any longer than a single page load. The normal day-to-
  // day mechanism is now the independently-revocable DEVICE credential
  // that period-analytics.js itself manages in its own localStorage
  // (established once via a one-time enrollment link, see
  // AnalyticsDeviceAuth.gs). Once a device is enrolled there, the plain
  // "Open Period Analytics" link below (no token in the URL at all)
  // already works, since that page reads its own stored device token.
  var ADMIN_TOKEN = new URLSearchParams(location.search).get('adminToken') || '';
  if (new URLSearchParams(location.search).has('adminToken')) {
    history.replaceState(null, '', location.pathname);
  }

  // 2026-10-06 audit: every request now goes through HMGNet (net.js) - hard
  // timeouts, classified failures, bounded exponential retry for TRANSIENT
  // failures only. Measured production response times (direct, repeated):
  // discoverGroups 3-5s (cold start up to ~11s), Worker->Apps Script POSTs
  // 3-13s, a rebuild of one date ~12s (it was ~93s before the backend
  // fixes) - so the ceilings below are generous but finite: nothing can
  // keep the page on "Loading..." forever any more.
  var Net = window.HMGNet;
  var TIMEOUTS = {
    status: 75000,       // getDailyAttendanceStatus / getDataSyncStatus (read-only); Apps Script latency spikes of 40s+ were measured even for trivial calls
    discover: 40000,     // discoverGroups JSONP (read-only)
    rebuild: 240000,     // ensureDateRangeFresh - Apps Script's own hard cap is 6 min
    refresh: 280000,     // refreshRawData (Jotform sync + rebuild)
    write: 60000,        // prepareReview (prepare / reissue / resend)
    report: 330000,      // generateV5Report
  };
  var SLOW_NOTICE_MS = 8000;

  /** Read-only JSONP GET with one automatic retry on a transient failure. */
  function jsonpGet(action, params, onSlow) {
    var p = Object.assign({ action: action }, params || {});
    return Net.withRetry(function () {
      return Net.jsonp(BACKEND, p, { timeoutMs: TIMEOUTS.discover, onSlow: onSlow, slowMs: SLOW_NOTICE_MS });
    }, { retries: 1, baseMs: 1500 });
  }

  // POST through the Worker bridge. `opts.retries` is explicit per call:
  // READ-ONLY and idempotent actions retry on transient failures; actions
  // that create real state (report generation = a Drive file) never do.
  function bridgePost(action, extra, opts) {
    opts = opts || {};
    return Net.withRetry(function () {
      return Net.postJson(WRITE_BRIDGE, Object.assign({ action: action }, extra || {}), { timeoutMs: opts.timeoutMs || TIMEOUTS.write });
    }, { retries: opts.retries || 0, baseMs: 1500, onRetry: opts.onRetry });
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

  // ================== ATTENDANCE PERIOD & REVIEW GROUPS (Phase 4, 2026-10-06) ==================
  // Workflow:  1. Select From/To  ->  2. Process Attendance  ->  3. Review groups  ->  4. Generate / Copy / Resend / Regenerate.
  // Nothing runs when a date changes - only the button starts processing. Every request has a timeout, every failure names
  // the stage that failed and offers a retry, so the page can never sit on "Loading..." for ever.
  //
  // Processing reuses what already exists on the server (no second ingestion path, no new Jotform integration):
  //   1. refreshRawData{syncOnly}    - the existing INCREMENTAL Jotform sync, without rebuilding any date
  //   2. ensureDateRangeFresh        - rebuilds ONLY the dates whose raw data is newer than their build (idempotent, locked,
  //                                    upserts Daily_Attendance - never duplicates, never touches other dates); sent in
  //                                    7-day batches so one request stays far below Apps Script's 6-minute cap
  //   3. discoverGroups{fromDate,toDate} - the groups that exist in the period (read-only)
  var PERIOD_KEY = 'hmgControlLastPeriod';
  var CHUNK_DAYS = 7;
  var WARN_DAYS = 62;
  var generation = 0;
  var processing = false;

  function byId(id) { return document.getElementById(id); }

  // ---- date helpers (pure, no timezone surprises: everything is UTC calendar arithmetic on YYYY-MM-DD) ----
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2020 || y > 2100) return null;
    var t = Date.UTC(y, mo - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return t;
  }
  function ymd(t) { return new Date(t).toISOString().slice(0, 10); }
  function daysInclusive(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1; }
  function chunkPeriod(from, to, size) {
    var out = [], t = parseYmd(from), end = parseYmd(to);
    while (t <= end) { var e = Math.min(t + (size - 1) * 86400000, end); out.push([ymd(t), ymd(e)]); t = e + 86400000; }
    return out;
  }
  function fmtDay(s) {
    try { return new Date(parseYmd(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return String(s); }
  }
  function periodLabel(from, to) { return from === to ? fmtDay(from) : fmtDay(from) + ' → ' + fmtDay(to); }
  function periodPlain(from, to) { return from === to ? from : from + ' to ' + to; }
  function todayRiyadh() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  /** {ok:true, days} or {ok:false, error}. */
  function validatePeriod(from, to) {
    if (!from) return { ok: false, error: 'Select a From date.' };
    if (!to) return { ok: false, error: 'Select a To date.' };
    if (parseYmd(from) === null) return { ok: false, error: 'The From date is not a valid date.' };
    if (parseYmd(to) === null) return { ok: false, error: 'The To date is not a valid date.' };
    if (parseYmd(from) > parseYmd(to)) return { ok: false, error: 'The From date must be on or before the To date.' };
    return { ok: true, days: daysInclusive(from, to) };
  }

  function showPeriodError(text) { byId('periodError').textContent = text || ''; }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function formatLocal(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
  }
  function setControlsDisabled(on) {
    byId('processBtn').disabled = on;
    byId('periodFrom').disabled = on;
    byId('periodTo').disabled = on;
  }

  /** Audit-only events (no state change), best effort: a failure here never disturbs the workflow. */
  function auditEvent(event, from, to, detail, extra) {
    try {
      var payload = Object.assign({ reviewDate: from, reviewType: 'DOCTORS', auditEvent: event, fromDate: from, toDate: to, detail: detail || '' }, extra || {});
      bridgePost('prepareReview', payload, { timeoutMs: 20000, retries: 0 }).then(null, function () { /* best effort */ });
    } catch (e) { /* ignore */ }
  }

  function stageError(stage, message, extra) {
    var e = { stage: stage, message: message };
    Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  var STAGE_TITLES = { SYNC: 'Sync failure', PROCESS: 'Processing failure', WRITE: 'Sheet write failure', DISCOVER: 'Discover failure' };

  // ------------------------------------------------------------------ Process Attendance
  function processAttendance(opts) {
    opts = opts || {};
    if (processing) return;
    var from = byId('periodFrom').value, to = byId('periodTo').value;
    var v = validatePeriod(from, to);
    if (!v.ok) { showPeriodError(v.error); return; }
    showPeriodError('');
    if (v.days > WARN_DAYS && !opts.confirmed &&
        !window.confirm('This period covers ' + v.days + ' days. It is processed safely in batches of ' + CHUNK_DAYS + ' days and can take several minutes the first time (dates that are already up to date are skipped). Continue?')) return;
    try { localStorage.setItem(PERIOD_KEY, JSON.stringify({ from: from, to: to })); } catch (e) { /* convenience only */ }

    var myGen = ++generation;
    processing = true;
    setControlsDisabled(true);
    clearChildren(byId('cardsHost'));
    clearChildren(byId('periodSummary'));
    var t0 = Date.now(), stageText = '', ticker = null, rebuilt = [];
    function current() { return myGen === generation; }
    function stage(text) { stageText = text; if (current()) setMsg(text); }
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
    function finish() { stopTicker(); if (current()) { processing = false; setControlsDisabled(false); } }
    ticker = setInterval(function () {
      if (!current()) { stopTicker(); return; }
      var sec = Math.round((Date.now() - t0) / 1000);
      if (sec >= 4) setMsg(stageText + ' (' + sec + ' sec)');
    }, 1000);

    function runSync() {
      stage('Syncing attendance data…');
      // dateStr is required by the bridge's request contract; in syncOnly mode the server rebuilds nothing.
      return bridgePost('refreshRawData', { dateStr: to, syncOnly: true }, { timeoutMs: TIMEOUTS.refresh, retries: 0 }).then(function (res) {
        if (!res.ok) {
          Net.logTech('period sync refused', { errorClass: res.errorClass, message: res.error });
          throw stageError('SYNC', 'Syncing attendance data failed. ' + ((res.errorClass === 'NETWORK' || res.retryable)
            ? 'The data source did not respond - this is usually temporary.' : 'The data source reported a problem.'), { skippable: true });
        }
        return res;
      }, function (e) {
        Net.logTech('period sync transport failure', e);
        throw stageError('SYNC', 'Syncing attendance data failed. ' + Net.userMessage(e && e.kind), { skippable: true });
      });
    }

    function runChunks() {
      var chunks = chunkPeriod(from, to, CHUNK_DAYS), i = 0;
      function next() {
        if (i >= chunks.length) return Promise.resolve();
        var c = chunks[i++];
        stage('Processing ' + periodLabel(from, to) + '… updating attendance records' + (chunks.length > 1 ? ' (batch ' + i + ' of ' + chunks.length + ': ' + fmtDay(c[0]) + ' – ' + fmtDay(c[1]) + ')' : ''));
        // retries:1 is safe - the call only rebuilds dates that are STILL stale, and the server serialises rebuilds with a lock.
        return bridgePost('ensureDateRangeFresh', { fromStr: c[0], toStr: c[1] }, { timeoutMs: TIMEOUTS.rebuild, retries: 1 }).then(function (res) {
          if (!current()) return null;
          if (!res.ok) {
            Net.logTech('period processing refused', { message: res.error });
            throw stageError('PROCESS', 'Processing attendance failed. ' + (res.error || 'The server could not process this period.'));
          }
          (res.rebuilt || []).forEach(function (r) { rebuilt.push(r); });
          if (res.anyFailed) {
            var bad = (res.rebuilt || []).filter(function (r) { return !r.ok; })[0] || {};
            Net.logTech('period rebuild failed', bad);
            var writeish = /Service Spreadsheets|timed out|write|setValues|appendRow|lock/i.test(String(bad.error || ''));
            throw stageError(writeish ? 'WRITE' : 'PROCESS', (writeish ? 'Saving the attendance records failed' : 'Processing attendance failed') + (bad.date ? ' for ' + fmtDay(bad.date) : '') + '. Nothing outside the failed day was changed.');
          }
          return next();
        }, function (e) {
          Net.logTech('period processing transport failure', e);
          throw stageError('PROCESS', 'Processing attendance failed. ' + Net.userMessage(e && e.kind));
        });
      }
      return next();
    }

    function runDiscover() {
      stage('Finding review groups…');
      return jsonpGet('discoverGroups', { fromDate: from, toDate: to }, function () {
        stage('Finding review groups… this can take longer during busier periods.');
      }).then(function (data) {
        if (!data.ok) {
          Net.logTech('period discover refused', { message: data.error });
          throw stageError('DISCOVER', 'Finding review groups failed. ' + Net.userMessage(Net.classifyBackend(data), data.error));
        }
        // write verification: every day the server just (re)built with rows must be visible to the reader
        var missing = rebuilt.filter(function (r) { return r.ok && r.rowCount > 0 && data.summary.daysWithoutData.indexOf(r.date) !== -1; }).map(function (r) { return r.date; });
        if (missing.length) throw stageError('WRITE', 'Attendance for ' + missing.map(fmtDay).join(', ') + ' was processed but is not in the sheet yet. Please retry.');
        return data;
      }, function (e) {
        Net.logTech('period discover transport failure', e);
        throw stageError('DISCOVER', 'Finding review groups failed. ' + Net.userMessage(e && e.kind));
      });
    }

    auditEvent('PERIOD_PROCESS_STARTED', from, to, 'days ' + v.days + (opts.skipSync ? ' (without sync)' : ''));
    var chain = opts.skipSync ? Promise.resolve() : runSync();
    chain.then(function () { if (current()) return runChunks(); })
      .then(function () { if (current()) return runDiscover(); })
      .then(function (data) {
        if (!data || !current()) return;
        renderSummary(data, from, to);
        var host = byId('cardsHost');
        data.cards.forEach(function (card) { host.appendChild(renderGroupCard(card, { from: from, to: to })); });
        stage('Ready.');
        console.log('TIMING processAttendance ' + (Date.now() - t0) + 'ms days=' + v.days + ' rebuilt=' + rebuilt.length);
        auditEvent('PERIOD_PROCESS_COMPLETED', from, to, 'employees ' + data.summary.employees + ', zones ' + data.summary.zones + ', doctors ' + data.summary.doctors + ', unmapped ' + data.summary.unmapped + ', rebuilt days ' + rebuilt.length);
        setTimeout(function () { if (current()) setMsg(''); }, 1500);
      })
      .catch(function (err) {
        stopTicker();
        if (!current()) return;
        var e = (err && err.stage) ? err : stageError('PROCESS', 'Processing attendance failed. ' + Net.userMessage(err && err.kind));
        auditEvent('PERIOD_PROCESS_FAILED', from, to, e.stage + ' failed');
        showProcessFailure(e);
      })
      .then(finish, finish);
  }

  function showProcessFailure(e) {
    var host = byId('statusMsg');
    clearChildren(host);
    host.appendChild(el('div', 'report-error', (STAGE_TITLES[e.stage] || 'Processing failure') + ': ' + e.message));
    var retry = el('button', 'btn-primary', 'Retry Processing');
    retry.addEventListener('click', function () { retry.disabled = true; processAttendance({ confirmed: true }); });
    host.appendChild(retry);
    if (e.skippable) {
      var skip = el('button', 'btn-secondary', 'Continue with existing data');
      skip.addEventListener('click', function () { skip.disabled = true; processAttendance({ confirmed: true, skipSync: true }); });
      host.appendChild(skip);
      host.appendChild(el('div', 'meta', 'Continuing skips the sync: the period is processed from the attendance data already stored.'));
    }
  }

  function statBox(value, label) {
    var b = el('div', 'stat-box');
    b.appendChild(el('div', 'stat-value', String(value)));
    b.appendChild(el('div', 'stat-label', label));
    return b;
  }
  function renderSummary(data, from, to) {
    var host = byId('periodSummary');
    clearChildren(host);
    var s = data.summary;
    var box = el('div', 'control-card');
    box.appendChild(el('div', 'group-title summary-ready', 'Attendance ready'));
    box.appendChild(el('div', 'meta', 'Period: ' + periodLabel(from, to)));
    var grid = el('div', 'stat-grid');
    grid.appendChild(statBox(s.employees, 'Employees'));
    grid.appendChild(statBox(s.zones, 'Zones'));
    grid.appendChild(statBox(s.doctors, 'Doctors'));
    grid.appendChild(statBox(s.unmapped, 'Unmapped'));
    box.appendChild(grid);
    if (s.unmapped > 0) {
      box.appendChild(el('div', 'notice', 'Unmapped: ' + s.unmapped + ' employee' + (s.unmapped === 1 ? '' : 's') + ' worked in an Area that is not in Settings' +
        (s.unmappedAreas && s.unmappedAreas.length ? ' (' + s.unmappedAreas.join(', ') + ')' : '') + '. They get no review group until the Area is added in Settings.'));
    }
    if (s.daysWithoutData && s.daysWithoutData.length) {
      var shown = s.daysWithoutData.slice(0, 8).map(fmtDay).join(', ') + (s.daysWithoutData.length > 8 ? ' and ' + (s.daysWithoutData.length - 8) + ' more' : '');
      box.appendChild(el('div', 'meta', 'No attendance recorded for: ' + shown + '.'));
    }
    if (!data.cards.length) box.appendChild(el('div', 'meta', 'There are no review groups in this period.'));
    host.appendChild(box);
  }

  // ------------------------------------------------------------------ Review groups: Generate / Copy / Resend / Regenerate
  // Returns the opened window, or null if the browser blocked the popup (a popup opened after an async request has no user gesture).
  function openWhatsApp(phone, ctx, card, url) {
    var msg = encodeURIComponent('HMG Attendance Review — ' + periodPlain(ctx.from, ctx.to) + ' · ' + groupLabel(card) + ': ' + url);
    return window.open('https://wa.me/' + normalizeSaudiPhone(phone) + '?text=' + msg, '_blank');
  }

  function periodPayload(card, ctx, extra) {
    var p = { reviewDate: ctx.from, reviewType: card.reviewType };
    if (ctx.to !== ctx.from) p.toDate = ctx.to; // a one-day period sends exactly what the legacy flow always sent
    if (card.reviewType === 'ZONE') p.zone = card.zone;
    return Object.assign(p, extra || {});
  }

  function showCardMessage(msgLine, text, isError, retryLabel, onRetry) {
    clearChildren(msgLine);
    msgLine.className = isError ? 'meta report-error' : 'meta';
    msgLine.appendChild(document.createTextNode(text + (onRetry ? ' ' : '')));
    if (onRetry) {
      var b = el('button', 'btn-secondary', retryLabel);
      b.addEventListener('click', function () { b.disabled = true; onRetry(); });
      msgLine.appendChild(b);
    }
  }

  function renderGroupCard(card, ctx) {
    var box = el('div', 'control-card');
    box.appendChild(el('div', 'group-title', groupLabel(card)));
    box.appendChild(el('div', 'meta', scopeLine(card)));
    box.appendChild(el('div', 'meta', countLabel(card) + (card.days ? ' · ' + card.days + (card.days === 1 ? ' day' : ' days') : '')));

    if (card.routingError) {
      box.appendChild(el('div', 'meta', reviewerLabel(card) + ': —'));
      box.appendChild(el('div', 'routing-error', card.routingError.indexOf('ambiguity') !== -1 ? 'Routing ambiguity' : 'Reviewer not configured'));
      return box;
    }

    var reviewerLine = el('div', 'meta');
    var phoneLine = el('div', 'meta');
    var statusLine = el('div', 'status-line');
    var resentLine = el('div', 'meta');
    var linkHost = el('div');
    var msgLine = el('div', 'meta');
    msgLine.setAttribute('role', 'status');
    var confirmHost = el('div');
    var actions = el('div', 'row-actions');
    [reviewerLine, phoneLine, statusLine, resentLine, linkHost, msgLine, confirmHost, actions].forEach(function (n) { box.appendChild(n); });

    function setBusy(on) { if (on) box.setAttribute('data-busy', '1'); else box.removeAttribute('data-busy'); }
    function isBusy() { return box.getAttribute('data-busy') === '1'; }

    function applyResult(res) {
      if (res.managerUrl !== undefined) card.managerUrl = res.managerUrl;
      if (res.reissueCount) card.reissueCount = res.reissueCount;
      if (res.reviewer) card.reviewer = res.reviewer;
      if (res.whatsapp) card.whatsapp = res.whatsapp;
      if (res.expiresAt) card.expiresAt = res.expiresAt;
      if (res.lastResentAt) card.lastResentAt = res.lastResentAt;
      if (res.status) card.status = res.status;
    }

    function paint() {
      reviewerLine.textContent = reviewerLabel(card) + ': ' + (card.reviewer || '—');
      phoneLine.textContent = card.whatsapp ? maskPhone(card.whatsapp) : '';
      phoneLine.hidden = !card.whatsapp;
      clearChildren(statusLine); clearChildren(linkHost); clearChildren(actions); clearChildren(confirmHost);
      var tag = el('span', 'tag tag-' + (card.status === 'NONE' ? 'PENDING' : card.status), card.status === 'NONE' ? 'NOT SENT' : card.status.replace('_', ' '));
      statusLine.appendChild(tag);
      resentLine.textContent = card.lastResentAt ? 'Last link prepared for WhatsApp: ' + formatLocal(card.lastResentAt) : '';
      resentLine.hidden = !card.lastResentAt;

      if (card.status === 'NONE') {
        if (card.blockedBy && card.blockedBy.length) {
          var b0 = card.blockedBy[0];
          linkHost.appendChild(el('div', 'notice', 'A live review link (' + periodPlain(b0.from, b0.to) + ', ' + b0.status.replace('_', ' ') + ') already covers part of this period for this group. Finish or regenerate that review, or choose a period that does not overlap it.'));
          return;
        }
        var gen = el('button', 'btn-primary', 'Generate Review Link');
        gen.addEventListener('click', function () { doGenerate(gen); });
        actions.appendChild(gen);
      } else if (card.status === 'COMPLETED') {
        linkHost.appendChild(el('div', 'meta', 'Review completed.'));
      } else if (card.status === 'EXPIRED' || card.status === 'REVOKED') {
        linkHost.appendChild(el('div', 'meta', card.status === 'EXPIRED' ? 'The review link has expired.' : 'The review link was revoked.'));
        var again = el('button', 'btn-primary', 'Generate New Link');
        again.addEventListener('click', function () { doRegenerate(again, true); });
        actions.appendChild(again);
      } else {
        if (card.managerUrl) {
          linkHost.appendChild(el('div', 'meta', 'Active Review Link'));
          var input = el('input', 'link-input');
          input.type = 'text'; input.readOnly = true; input.value = card.managerUrl;
          input.setAttribute('aria-label', 'Active review link');
          input.addEventListener('focus', function () { input.select(); });
          linkHost.appendChild(input);
          var copy = el('button', 'btn-secondary', 'Copy Link');
          copy.addEventListener('click', function () { copyLink(input, msgLine); });
          actions.appendChild(copy);
          var send = el('button', 'btn-primary', 'Resend via WhatsApp');
          send.addEventListener('click', function () { doResend(send); });
          actions.appendChild(send);
        } else {
          linkHost.appendChild(el('div', 'meta', 'The link for this review is not available here - use Regenerate Link to create a fresh one.'));
        }
        var regen = el('button', 'btn-secondary', 'Regenerate Link');
        regen.addEventListener('click', function () { askRegenerate(); });
        actions.appendChild(regen);
      }
    }

    function copyLink(input, msg) {
      var url = card.managerUrl;
      function done() { showCardMessage(msg, 'Link copied to the clipboard.', false); }
      function manual() { input.focus(); input.select(); showCardMessage(msg, 'Copying was blocked by the browser - the link is selected, press Ctrl+C to copy it.', true); }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(done, function () { fallback(); }); return; }
      } catch (e) { /* fall through */ }
      fallback();
      function fallback() {
        try { input.focus(); input.select(); if (document.execCommand && document.execCommand('copy')) done(); else manual(); } catch (e) { manual(); }
      }
    }

    // GENERATE: first link for this group + period. Find-or-create on the server, so a double click or a retry gets the same link.
    function doGenerate(btn) {
      if (isBusy()) return;
      setBusy(true);
      btn.disabled = true; btn.textContent = 'Generating…';
      showCardMessage(msgLine, 'Generating the review link…', false);
      function failed(text, canRetry) {
        showCardMessage(msgLine, text, true, 'Retry', canRetry ? function () { setBusy(false); paint(); doGenerateAgain(); } : null);
        setBusy(false); btn.disabled = false; btn.textContent = 'Generate Review Link';
      }
      function doGenerateAgain() { var b = actions.querySelector('button'); if (b) doGenerate(b); }
      bridgePost('prepareReview', periodPayload(card, ctx), { timeoutMs: TIMEOUTS.write, retries: 1 }).then(function (res) {
        if (!res.ok) { var kind = Net.classifyBackend(res); failed('Could not generate the review link. ' + Net.userMessage(kind, res.error), Net.isRetryableKind(kind)); return; }
        applyResult(res);
        setBusy(false);
        paint();
        showCardMessage(msgLine, 'Review link created. Copy it, or open WhatsApp to send it.', false);
      }).catch(function (e) {
        Net.logTech('generate failed', e);
        failed('Could not generate the review link. ' + Net.userMessage(e && e.kind), true);
      });
    }

    // RESEND: same link if it is still valid (never a new one); the server only rotates when the reviewer behind the group changed.
    function doResend(btn) {
      if (isBusy()) return;
      setBusy(true);
      var label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Preparing link…';
      showCardMessage(msgLine, 'Preparing the link…', false);
      function unlock() { setBusy(false); btn.disabled = false; btn.textContent = label; }
      function retry() { unlock(); doResend(btn); }
      bridgePost('prepareReview', periodPayload(card, ctx, { resend: 'true' }), { timeoutMs: TIMEOUTS.write, retries: 1 }).then(function (res) {
        if (!res.ok) {
          var kind = Net.classifyBackend(res);
          if (res.code === 'COMPLETED') { card.status = 'COMPLETED'; unlock(); paint(); showCardMessage(msgLine, 'This review is already completed - there is nothing to resend.', false); return; }
          showCardMessage(msgLine, 'Could not prepare the link. ' + Net.userMessage(kind, res.error), true, 'Retry Resend', Net.isRetryableKind(kind) ? retry : null);
          unlock();
          return;
        }
        if (!res.managerUrl) { showCardMessage(msgLine, 'The review link could not be retrieved. Please try again.', true, 'Retry Resend', retry); unlock(); return; }
        var rotated = res.linkReused === false;
        applyResult(res);
        var opened = openWhatsApp(res.whatsapp || card.whatsapp, ctx, card, res.managerUrl);
        setBusy(false);
        paint();
        if (opened) {
          auditEvent('WHATSAPP_HANDOFF_OPENED', ctx.from, ctx.to, 'wa.me opened', { reviewType: card.reviewType, zone: card.zone, assignmentId: card.assignmentId });
          showCardMessage(msgLine, (rotated ? 'The reviewer for this group changed, so a new link was created and the previous one no longer works. ' : '') + 'WhatsApp opened. Press Send to deliver the review link - nothing has been sent yet.', false);
        } else {
          clearChildren(msgLine);
          msgLine.className = 'meta';
          msgLine.appendChild(document.createTextNode((rotated ? 'A new review link was created for ' : 'Review link ready for ') + card.reviewer + ' (nothing has been sent). The browser blocked the WhatsApp window. '));
          var waBtn = el('button', 'btn-primary', 'Open WhatsApp');
          waBtn.addEventListener('click', function () {
            if (openWhatsApp(card.whatsapp, ctx, card, card.managerUrl)) {
              auditEvent('WHATSAPP_HANDOFF_OPENED', ctx.from, ctx.to, 'wa.me opened (after popup block)', { reviewType: card.reviewType, zone: card.zone, assignmentId: card.assignmentId });
              showCardMessage(msgLine, 'WhatsApp opened. Press Send to deliver the review link - nothing has been sent yet.', false);
            } else {
              showCardMessage(msgLine, 'WhatsApp is still blocked by the browser. Allow pop-ups for this page, or use Copy Link.', true);
            }
          });
          msgLine.appendChild(waBtn);
        }
      }).catch(function (e) {
        Net.logTech('resend failed', e);
        showCardMessage(msgLine, 'Could not prepare the link. ' + Net.userMessage(e && e.kind), true, 'Retry Resend', retry);
        unlock();
      });
    }

    // REGENERATE: a different action from Resend - it ALWAYS replaces the link. Needs an explicit confirmation.
    function askRegenerate() {
      if (isBusy()) return;
      clearChildren(confirmHost);
      var panel = el('div', 'confirm-box');
      panel.appendChild(el('div', 'group-title', 'Generate a new review link for ' + (card.reviewer || 'this reviewer') + ' / ' + groupLabel(card) + '?'));
      panel.appendChild(el('div', 'meta', 'The current link will stop working immediately. Decisions already saved are kept.'));
      var cancel = el('button', 'btn-secondary', 'Cancel');
      cancel.addEventListener('click', function () { clearChildren(confirmHost); });
      var go = el('button', 'btn-primary', 'Regenerate');
      go.addEventListener('click', function () { clearChildren(confirmHost); doRegenerate(go, false); });
      panel.appendChild(cancel); panel.appendChild(go);
      confirmHost.appendChild(panel);
    }

    function doRegenerate(btn, fromExpired) {
      if (isBusy()) return; // double-click guard (the server also refuses a second regeneration of the same revision)
      setBusy(true);
      var expected = String(card.reissueCount || 1);
      Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = true; });
      showCardMessage(msgLine, fromExpired ? 'Generating a new link…' : 'Regenerating the link…', false);
      function unlock() { setBusy(false); paint(); }
      function retry() { setBusy(false); doRegenerate(btn, fromExpired); }
      // Retrying the SAME request (same expected revision) is safe: if the first attempt already landed, the server
      // hands back the link it created instead of making another.
      bridgePost('prepareReview', periodPayload(card, ctx, { regenerate: 'true', expectedRevision: expected }), { timeoutMs: TIMEOUTS.write, retries: 1 }).then(function (res) {
        if (!res.ok) {
          var kind = Net.classifyBackend(res);
          if (res.code === 'COMPLETED') { card.status = 'COMPLETED'; unlock(); showCardMessage(msgLine, 'This review is already completed. Its link can no longer be replaced.', false); return; }
          unlock();
          showCardMessage(msgLine, 'Regeneration failed: ' + Net.userMessage(kind, res.error) + ' The current link was not changed.', true, 'Retry Regenerate', Net.isRetryableKind(kind) ? retry : null);
          return;
        }
        applyResult(res);
        unlock();
        if (res.alreadyRegenerated) {
          showCardMessage(msgLine, 'This link had just been replaced (another click or tab). The current link is shown - no second link was created.', false);
        } else {
          showCardMessage(msgLine, 'New review link created. The previous link no longer works.' + (res.reviewerChanged ? ' The reviewer for this group has changed - the new link is for ' + res.reviewer + '.' : ''), false);
        }
      }).catch(function (e) {
        Net.logTech('regenerate failed', e);
        unlock();
        showCardMessage(msgLine, 'Regeneration failed: ' + Net.userMessage(e && e.kind) + ' The current link may be unchanged - press Retry to check.', true, 'Retry Regenerate', retry);
      });
    }

    paint();
    return box;
  }

  byId('processBtn').addEventListener('click', function () { processAttendance(); });
  // enter key in a date field does nothing on purpose: only the button processes.
  // Restore the last period (a convenience only), else default to today in the operating timezone (Asia/Riyadh).
  (function initPeriodInputs() {
    var from = '', to = '';
    try {
      var saved = JSON.parse(localStorage.getItem(PERIOD_KEY) || 'null');
      if (saved && validatePeriod(saved.from, saved.to).ok) { from = saved.from; to = saved.to; }
    } catch (e) { /* ignore */ }
    if (!from) { from = to = todayRiyadh(); }
    byId('periodFrom').value = from;
    byId('periodTo').value = to;
    setMsg('Select the period and press Process Attendance.');
  })();

  // ================== DATA SYNC (refreshRawData bridge) ==================
  // Reuses the EXISTING buildDailyAttendance refresh logic verbatim
  // (same call ccRefreshRawData already makes server-side) - this page
  // adds no second ingestion path, and All_Submissions itself is fed
  // directly by Jotform's own Sheets integration outside this project,
  // so there is nothing here to "fetch" beyond re-reading what's
  // already arrived and rebuilding Daily_Attendance from it. Open to
  // anyone with this page's URL, same as Daily Operations/Reports.
  (function initDataSync() {
    var statusLine = document.getElementById('dataSyncStatusLine');
    var resultHost = document.getElementById('dataSyncResult');
    var btn = document.getElementById('refreshDataBtn');

    function formatStatusLine(rawRowCount, lastRefreshAt) {
      var parts = ['Current raw row count: ' + rawRowCount.toLocaleString()];
      parts.push(lastRefreshAt
        ? 'Last successful refresh: ' + new Date(lastRefreshAt).toLocaleString()
        : 'Last successful refresh: never');
      return parts.join(' · ');
    }

    // Returns a Promise of the status body (or null on failure) so the
    // refresh flow can use it to CONFIRM an uncertain refresh.
    function loadStatus() {
      return bridgePost('getDataSyncStatus', {}, { timeoutMs: TIMEOUTS.status, retries: 2 }).then(function (res) {
        if (!res.ok) { statusLine.textContent = 'Status unavailable.'; Net.logTech('getDataSyncStatus refused', res); return null; }
        statusLine.textContent = formatStatusLine(res.rawRowCount, res.lastRefreshAt);
        return res;
      }).catch(function (e) {
        Net.logTech('getDataSyncStatus failed', e);
        statusLine.textContent = 'Status unavailable (' + Net.userMessage(e && e.kind).replace(/ Please.*$/, '') + ').';
        return null;
      });
    }
    var statusBeforeRefresh = null;
    loadStatus().then(function (s) { statusBeforeRefresh = s; });

    // Typical observed duration for a full refresh - a client-side
    // ESTIMATE only (see the same disclaimer pattern used for report
    // generation below); the backend has no granular progress signal
    // to report mid-request.
    var DATA_SYNC_ESTIMATED_SECONDS = 75;
    var DATA_SYNC_STAGES = ['Connecting to source', 'Fetching latest submissions', 'Updating raw data', 'Validating records', 'Finalizing'];
    function stageForSyncProgress(pct) {
      if (pct < 15) return DATA_SYNC_STAGES[0];
      if (pct < 55) return DATA_SYNC_STAGES[1];
      if (pct < 80) return DATA_SYNC_STAGES[2];
      if (pct < 94) return DATA_SYNC_STAGES[3];
      return DATA_SYNC_STAGES[4];
    }
    function estimatedSyncProgressPct(elapsedMs, estimatedMs) {
      var ratio = elapsedMs / estimatedMs;
      return Math.min(96, (1 - Math.exp(-1.1 * ratio)) * 96);
    }

    function refreshData() {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';

      var startTime = Date.now();
      resultHost.innerHTML = '';
      var panel = el('div', 'control-card');
      var title = el('div', 'group-title', 'Refreshing attendance data');
      var barOuter = el('div', 'progress-bar-outer');
      var barInner = el('div', 'progress-bar-inner');
      barOuter.appendChild(barInner);
      var pctText = el('div', 'progress-pct', '0%');
      var stageText = el('div', 'meta', 'Current stage: ' + DATA_SYNC_STAGES[0]);
      var timeText = el('div', 'meta', 'Elapsed: 0 sec');
      var note = el('div', 'meta progress-estimate-note', 'Percentage and time remaining are estimates based on typical refresh durations, not exact backend progress.');
      panel.appendChild(title); panel.appendChild(barOuter); panel.appendChild(pctText);
      panel.appendChild(stageText); panel.appendChild(timeText); panel.appendChild(note);
      resultHost.appendChild(panel);

      var tickHandle = setInterval(function () {
        var elapsedMs = Date.now() - startTime;
        var pct = estimatedSyncProgressPct(elapsedMs, DATA_SYNC_ESTIMATED_SECONDS * 1000);
        barInner.style.width = pct.toFixed(0) + '%';
        pctText.textContent = pct.toFixed(0) + '%';
        stageText.textContent = 'Current stage: ' + stageForSyncProgress(pct);
        var elapsedSec = Math.round(elapsedMs / 1000);
        var remainingMs = DATA_SYNC_ESTIMATED_SECONDS * 1000 - elapsedMs;
        timeText.textContent = 'Elapsed: ' + elapsedSec + ' sec' +
          (remainingMs > 1500 ? ' · Estimated remaining: ~' + Math.round(remainingMs / 1000) + ' sec' : ' · finishing up…');
      }, 400);

      var reviewDate = document.getElementById('periodTo').value || todayRiyadh();

      function showRetry(parent, label) {
        var b = el('button', 'btn-primary', label);
        b.addEventListener('click', function () { b.disabled = true; refreshData(); });
        parent.appendChild(b);
      }

      // The backend itself retries the Jotform sync on transient failures
      // (bounded, see DataSyncBridge.gs), so this single call is not retried
      // again here - a second client-side attempt would just queue behind the
      // first one's lock.
      bridgePost('refreshRawData', { dateStr: reviewDate }, { timeoutMs: TIMEOUTS.refresh, retries: 0 }).then(function (res) {
        clearInterval(tickHandle);
        btn.disabled = false;
        btn.textContent = 'Refresh Data';
        var elapsedSec = Math.round((Date.now() - startTime) / 1000);

        if (!res.ok) {
          // A real, confirmed backend response - genuinely did not
          // succeed, so a definitive failure message is accurate here.
          // Diagnostic detail (attempt count/last upstream status, never
          // a secret or token) goes to console only - Phase 13 (2026-09-
          // 29): a future genuine contract break should be distinguishable
          // from this known transient echo-redirect flakiness by whoever
          // is debugging it, without exposing internals to the operator.
          if (res.debug) console.log('REFRESH_DIAGNOSTIC', JSON.stringify(res.debug));
          Net.logTech('refreshRawData refused', { kind: Net.classifyBackend(res), errorClass: res.errorClass, message: res.error });
          resultHost.innerHTML = '';
          resultHost.appendChild(el('div', 'meta report-error', 'Could not complete data collection.'));
          resultHost.appendChild(el('div', 'meta progress-estimate-note',
            (res.errorClass === 'NETWORK' || res.retryable)
              ? 'The data source did not respond. This is usually temporary - trying again in a moment often succeeds.'
              : 'The data source reported a problem. Please try again; if it keeps happening, contact the office.'));
          showRetry(resultHost, 'Retry Data Collection');
          return;
        }

        resultHost.innerHTML = '';
        var doneBox = el('div', 'control-card');
        doneBox.appendChild(el('div', 'group-title', 'Data refreshed successfully ✓'));
        if (res.newRows !== null && res.newRows !== undefined) {
          doneBox.appendChild(el('div', 'meta', 'New records: ' + res.newRows.toLocaleString()));
        }
        doneBox.appendChild(el('div', 'meta', 'Current total rows: ' + res.rawRowCount.toLocaleString()));
        doneBox.appendChild(el('div', 'meta', 'Completed in ' + elapsedSec + ' sec'));
        doneBox.appendChild(el('div', 'meta', 'Last updated: ' + new Date(res.refreshedAt).toLocaleString()));
        resultHost.appendChild(doneBox);
        statusLine.textContent = formatStatusLine(res.rawRowCount, res.refreshedAt);
      }).catch(function (e) {
        clearInterval(tickHandle);
        btn.disabled = false;
        btn.textContent = 'Refresh Data';
        Net.logTech('refreshRawData transport failure', e);
        // A network-level failure (e.g. the Worker/browser relay timing
        // out) is NOT proof the backend failed - never claim "not
        // updated" here (that asserts a fact we don't actually know),
        // and never claim success either. So instead of leaving the person
        // guessing, ask the status endpoint whether the refresh actually
        // landed (its "last refresh" time moved) and say what we found.
        resultHost.innerHTML = '';
        resultHost.appendChild(el('div', 'meta report-slow-notice', 'Checking whether the refresh completed…'));
        loadStatus().then(function (s) {
          resultHost.innerHTML = '';
          var before = statusBeforeRefresh && statusBeforeRefresh.lastRefreshAt;
          if (s && s.lastRefreshAt && s.lastRefreshAt !== before) {
            statusBeforeRefresh = s;
            resultHost.appendChild(el('div', 'meta', 'The refresh did complete (the connection dropped before the confirmation arrived).'));
            return;
          }
          resultHost.appendChild(el('div', 'meta report-slow-notice',
            'Could not confirm the refresh completed. ' + Net.userMessage(e && e.kind)));
          showRetry(resultHost, 'Retry Data Collection');
        });
      });
    }
    btn.addEventListener('click', refreshData);
  })();

  // ================== REPORTS (generateV5Report bridge) ==================
  // Calls the EXISTING production V5 report generators verbatim, through
  // the same POST-only Worker bridge every mutation already uses - never
  // GET/JSONP (report generation creates a real Drive file, a side
  // effect). The Worker forwards this one action to a DIFFERENT backend
  // (production's own Apps Script, not this isolated project's).
  //
  // ACCESS (2026-09-09): open to anyone with this page's URL, same as
  // Daily Operations/Review Center above - a deliberate access
  // simplification, not an oversight. No Analytics Admin token is
  // required or sent any more; production's own generateV5Report no
  // longer checks one. Period Analytics stays separately gated below -
  // its admin-token model is untouched.
  (function initReports() {
    document.getElementById('reportsForm').hidden = false;

    // Admin token (if present in the URL) still only unlocks the Period
    // Analytics link - that module's own security model is unchanged.
    // Report generation itself no longer needs or uses it.
    if (ADMIN_TOKEN) {
      document.getElementById('periodAnalyticsLink').href = 'period-analytics.html?adminToken=' + encodeURIComponent(ADMIN_TOKEN);
    }

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

      // Never auto-retried: a report is a real Drive file, a blind repeat
      // could create a duplicate.
      bridgePost('generateV5Report', payload, { timeoutMs: TIMEOUTS.report, retries: 0 }).then(function (res) {
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
