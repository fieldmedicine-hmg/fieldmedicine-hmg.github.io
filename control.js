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

  // Race-guard (2026-09-10 bug fix): changing the Review Date quickly
  // (or reloading while a slow request is still in flight) must never
  // let an OLDER, slower response overwrite the UI for whatever date is
  // now actually selected - each reload() call gets its own generation
  // number, and only the LATEST one is allowed to touch the DOM.
  var reloadGeneration = 0;

  function setMsgWithRetry(text, retryLabel, onRetry) {
    var host = document.getElementById('statusMsg');
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(document.createTextNode(text + ' '));
    var b = el('button', 'btn-primary', retryLabel);
    b.addEventListener('click', function () { b.disabled = true; onRetry(); });
    host.appendChild(b);
  }

  /**
   * Daily Operations load (2026-10-06 audit rewrite of the same flow):
   *   Connecting to data source -> [Loading attendance data, only if the
   *   date is stale] -> Processing employees -> Preparing manager groups
   *   -> Ready.
   * Every request has a timeout; read-only ones retry transient failures; a
   * failure ends in a clear message + "Retry Data Collection" (never an
   * endless spinner and never a full page refresh).
   *
   * Automatic sheet freshness (2026-09-10): before discovering review
   * groups for the selected date, check whether Daily_Attendance for
   * THAT SPECIFIC date is current relative to All_Submissions (and any
   * Area->Zone mapping fix) - reusing the SAME deterministic signal
   * Data Sync's own status check already uses, never a weak global
   * row-count guess. Only THAT one date is ever rebuilt, and only when
   * actually stale - a current date never pays this cost.
   */
  function reload() {
    var reviewDate = document.getElementById('reviewDateInput').value;
    if (!reviewDate) return;
    try { localStorage.setItem(LAST_DATE_KEY, reviewDate); } catch (e) { /* ignore */ }
    var myGeneration = ++reloadGeneration;
    var host = document.getElementById('cardsHost');
    while (host.firstChild) host.removeChild(host.firstChild);
    var dateInput = document.getElementById('reviewDateInput');
    dateInput.disabled = true; // debounce - one in-flight check/rebuild/discover cycle at a time
    var startedAt = Date.now();
    var tickHandle = null;

    function current() { return myGeneration === reloadGeneration; }
    function stage(text) { if (current()) setMsg(text); }
    function stopTick() { if (tickHandle) { clearInterval(tickHandle); tickHandle = null; } }
    function finish() { stopTick(); if (current()) dateInput.disabled = false; }
    function fail(errOrBody, isBody) {
      stopTick();
      if (!current()) return;
      var kind = isBody ? Net.classifyBackend(errOrBody) : (errOrBody && errOrBody.kind) || 'BACKEND';
      Net.logTech('data collection failed', isBody ? { kind: kind, message: errOrBody && errOrBody.error } : errOrBody);
      setMsgWithRetry('Could not complete data collection. ' + Net.userMessage(kind, isBody && errOrBody ? errOrBody.error : null), 'Retry Data Collection', reload);
      finish();
    }

    stage('Connecting to data source…');
    bridgePost('getDailyAttendanceStatus', { dateStr: reviewDate }, {
      timeoutMs: TIMEOUTS.status, retries: 2,
      onRetry: function () { stage('Connection is slow - retrying…'); },
    }).then(function (statusRes) {
      if (!current()) return null;
      if (!statusRes.ok) { fail(statusRes, true); return null; }
      if (!statusRes.stale) return true; // already current - skip straight to discovery, stays fast
      return ensureFresh(reviewDate);
    }).then(function (proceed) {
      if (proceed !== true || !current()) return;
      stopTick();
      stage('Processing employees…');
      return jsonpGet('discoverGroups', { reviewDate: reviewDate }, function () {
        stage('Preparing manager groups… this can take longer during busier periods.');
      }).then(function (data) {
        if (!current()) return;
        if (!data.ok) { fail(data, true); return; }
        if (!data.cards.length) {
          // Reached only after confirming freshness above, so an empty
          // result here is genuinely zero, not stale data - still double-
          // checked via checkDailyAttendanceBuilt rather than assumed.
          setMsg('');
          checkDailyAttendanceBuilt(reviewDate, myGeneration);
          return;
        }
        stage('Preparing manager groups…');
        data.cards.forEach(function (card) { host.appendChild(renderCard(card, reviewDate)); });
        stage('Ready.');
        console.log('TIMING dailyOperationsLoad ' + (Date.now() - startedAt) + 'ms');
        setTimeout(function () { if (current()) setMsg(''); }, 1500);
      });
    }).catch(function (e) {
      fail(e, false);
    }).then(finish, finish);

    /** Rebuilds the stale date, with a live seconds counter. If the request
     * dies at the transport level (timeout / network) the rebuild may still
     * be running or even finished on the server - so instead of guessing, ask
     * the status endpoint a few times whether the date became current. */
    function ensureFresh(date) {
      stage('Loading attendance data… (0 sec)');
      var t0 = Date.now();
      tickHandle = setInterval(function () {
        if (!current()) { stopTick(); return; }
        setMsg('Loading attendance data… (' + Math.round((Date.now() - t0) / 1000) + ' sec)');
      }, 1000);
      return bridgePost('ensureDateRangeFresh', { fromStr: date, toStr: date }, { timeoutMs: TIMEOUTS.rebuild, retries: 0 }).then(function (freshRes) {
        stopTick();
        if (!current()) return null;
        if (!freshRes.ok || freshRes.anyFailed) {
          var firstErr = (freshRes.rebuilt || []).filter(function (r) { return !r.ok; })[0];
          fail({ ok: false, error: (firstErr && firstErr.error) || freshRes.error || 'The attendance update did not complete.' }, true);
          return null;
        }
        return true;
      }, function (err) {
        Net.logTech('ensureDateRangeFresh transport failure', err);
        return verifyFreshAfterUncertainRebuild(date, err);
      });
    }

    function verifyFreshAfterUncertainRebuild(date, originalErr) {
      var attempts = 0, MAX = 4;
      function check() {
        if (!current()) return null;
        attempts++;
        stage('Checking whether the update finished… (' + attempts + '/' + MAX + ')');
        return bridgePost('getDailyAttendanceStatus', { dateStr: date }, { timeoutMs: TIMEOUTS.status, retries: 0 }).then(function (s) {
          if (s.ok && !s.stale) return true;
          if (attempts >= MAX) throw originalErr;
          return new Promise(function (r) { setTimeout(r, 8000); }).then(check);
        }, function (e2) {
          if (attempts >= MAX) throw originalErr;
          return new Promise(function (r) { setTimeout(r, 8000); }).then(check);
        });
      }
      return check();
    }
  }

  function checkDailyAttendanceBuilt(reviewDate, myGeneration) {
    var host = document.getElementById('cardsHost');
    bridgePost('getDailyAttendanceStatus', { dateStr: reviewDate }, { timeoutMs: TIMEOUTS.status, retries: 1 }).then(function (res) {
      if (myGeneration !== reloadGeneration) return;
      if (res.ok && !res.built) {
        host.appendChild(el('div', 'meta', 'This date has not been processed yet. Use "Refresh Data" above for this date, then reload.'));
      } else {
        host.appendChild(el('div', 'meta', 'No attendance found for this date.'));
      }
    }).catch(function () {
      if (myGeneration !== reloadGeneration) return;
      // Status check itself failed - fall back to the plain, already-
      // accurate statement rather than blocking on a second failure.
      host.appendChild(el('div', 'meta', 'No attendance found for this date.'));
    });
  }

  function formatLocal(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
  }

  // Returns the opened window, or null if the browser blocked the popup (a
  // popup opened after an async request has no user gesture).
  function openWhatsApp(phone, reviewDate, card, url) {
    var msg = encodeURIComponent('HMG Attendance Review — ' + reviewDate + ' · ' + groupLabel(card) + ': ' + url);
    return window.open('https://wa.me/' + normalizeSaudiPhone(phone) + '?text=' + msg, '_blank');
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

    var resentLine = el('div', 'meta', card.lastResentAt ? 'Last link prepared for WhatsApp: ' + formatLocal(card.lastResentAt) : '');
    if (!card.lastResentAt) resentLine.hidden = true;
    box.appendChild(resentLine);
    var msgLine = el('div', 'meta');
    msgLine.setAttribute('role', 'status');
    box.appendChild(msgLine);

    var actions = el('div', 'row-actions');

    if (card.status === 'NONE') {
      var prepareBtn = el('button', 'btn-primary', 'Prepare');
      prepareBtn.addEventListener('click', function () { doPrepare(card, reviewDate, prepareBtn, box, msgLine); });
      actions.appendChild(prepareBtn);
    } else if (card.status === 'COMPLETED') {
      // No send button - a completed review is done and can never be
      // resent or reissued (the backend refuses both).
      box.appendChild(el('div', 'meta', 'Review submitted.'));
    } else {
      var needsNewLink = card.status === 'EXPIRED' || card.status === 'REVOKED';
      var resendBtn = el('button', 'btn-primary', needsNewLink ? 'Resend via WhatsApp (new link)' : 'Resend via WhatsApp');
      resendBtn.addEventListener('click', function () {
        doResend(card, reviewDate, resendBtn, box, tag, resentLine, msgLine, needsNewLink);
      });
      actions.appendChild(resendBtn);
    }

    box.appendChild(actions);
    return box;
  }

  function showCardMessage(msgLine, text, isError, retryLabel, onRetry) {
    while (msgLine.firstChild) msgLine.removeChild(msgLine.firstChild);
    msgLine.className = isError ? 'meta report-error' : 'meta';
    msgLine.appendChild(document.createTextNode(text + (onRetry ? ' ' : '')));
    if (onRetry) {
      var b = el('button', 'btn-secondary', retryLabel);
      b.addEventListener('click', function () { b.disabled = true; onRetry(); });
      msgLine.appendChild(b);
    }
  }

  /**
   * RESEND (2026-10-06): re-sends the review link for ONE group to ITS
   * reviewer. Never blind - the backend (prepareReview resend=true) looks at
   * the assignment first:
   *   - link still valid  -> the SAME link is reused (nothing changes);
   *   - expired / revoked / reviewer changed -> ONE new link is issued and
   *     the old one stops working (so there are never two live links);
   *   - already submitted -> refused with a clear reason.
   * Every resend is written to Audit_Log (RESEND_REQUESTED / _COMPLETED).
   * A link-changing resend asks for confirmation first. The button is
   * disabled while the request is in flight and the backend runs inside its
   * assignment lock, so a double-click can never create two links.
   *
   * Honest scope: WhatsApp cannot be driven from here and the system cannot
   * observe delivery. This prepares/looks up the link, logs it, and opens the
   * wa.me chat with the message pre-filled; the person presses Send. Every
   * label and message says exactly that ("Resend via WhatsApp", "WhatsApp
   * opened ... nothing has been sent yet") and never claims the message was
   * sent or delivered. If the browser blocks the popup the message says the
   * link is ready and offers an Open WhatsApp button.
   */
  function doResend(card, reviewDate, btn, box, tag, resentLine, msgLine, needsNewLink) {
    if (box.getAttribute('data-busy') === '1') return; // duplicate-click guard
    if (needsNewLink && !window.confirm('Create a NEW review link for ' + card.reviewer + ' and open WhatsApp?\n\nThe previous link will stop working. Nothing is sent automatically - you press Send in WhatsApp.')) return;
    box.setAttribute('data-busy', '1');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing link…';
    showCardMessage(msgLine, 'Preparing the link…', false);

    var payload = { reviewDate: reviewDate, reviewType: card.reviewType, resend: 'true' };
    if (card.reviewType === 'ZONE') payload.zone = card.zone;

    function unlock() { box.removeAttribute('data-busy'); btn.disabled = false; btn.textContent = label; }
    function retry() { unlock(); doResend(card, reviewDate, btn, box, tag, resentLine, msgLine, false); }

    // One automatic retry on a transport failure is safe: if the first
    // attempt actually landed, the retry just sees the (new) live link and
    // reuses it - it cannot mint a second one.
    bridgePost('prepareReview', payload, { timeoutMs: TIMEOUTS.write, retries: 1 }).then(function (res) {
      if (!res.ok) {
        var kind = Net.classifyBackend(res);
        var text = Net.userMessage(kind, res.error);
        var canRetry = Net.isRetryableKind(kind);
        showCardMessage(msgLine, text, true, 'Retry Resend', canRetry ? retry : null);
        unlock();
        return;
      }
      if (!res.managerUrl) {
        showCardMessage(msgLine, 'The review link could not be retrieved. Please try again.', true, 'Retry Resend', retry);
        unlock();
        return;
      }
      var opened = openWhatsApp(res.whatsapp || card.whatsapp, reviewDate, card, res.managerUrl);
      if (res.lastResentAt) { resentLine.hidden = false; resentLine.textContent = 'Last link prepared for WhatsApp: ' + formatLocal(res.lastResentAt); }
      if (res.linkReused === false) {
        tag.className = 'tag tag-PREPARED';
        tag.textContent = 'PREPARED';
        card.status = 'PREPARED';
      }
      if (opened) {
        showCardMessage(msgLine, (res.linkReused === false ? 'New review link created. ' : '') + 'WhatsApp opened with the review link for ' + card.reviewer + '. Press Send in WhatsApp to deliver it - nothing has been sent yet.', false);
      } else {
        // Popup blocked: hand the person a real button (a click is a user gesture).
        while (msgLine.firstChild) msgLine.removeChild(msgLine.firstChild);
        msgLine.className = 'meta';
        msgLine.appendChild(document.createTextNode((res.linkReused === false ? 'New review link created for ' : 'Review link ready for ') + card.reviewer + ' (nothing has been sent). '));
        var waBtn = el('button', 'btn-primary', 'Open WhatsApp');
        waBtn.addEventListener('click', function () {
          openWhatsApp(res.whatsapp || card.whatsapp, reviewDate, card, res.managerUrl);
        });
        msgLine.appendChild(waBtn);
      }
      unlock();
    }).catch(function (e) {
      Net.logTech('resend failed', e);
      showCardMessage(msgLine, Net.userMessage(e && e.kind), true, 'Retry Resend', retry);
      unlock();
    });
  }

  function doPrepare(card, reviewDate, btn, box, msgLine) {
    if (box.getAttribute('data-busy') === '1') return; // duplicate-click guard
    box.setAttribute('data-busy', '1');
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    var payload = { reviewDate: reviewDate, reviewType: card.reviewType };
    if (card.reviewType === 'ZONE') payload.zone = card.zone;
    function unlock() { box.removeAttribute('data-busy'); btn.disabled = false; btn.textContent = 'Prepare'; }
    // Retry is safe: the backend returns the already-prepared link instead
    // of minting a second one (find-or-create under its assignment lock).
    bridgePost('prepareReview', payload, { timeoutMs: TIMEOUTS.write, retries: 1 }).then(function (res) {
      if (!res.ok) {
        var kind = Net.classifyBackend(res);
        showCardMessage(msgLine, Net.userMessage(kind, res.error), true, 'Retry', function () { unlock(); doPrepare(card, reviewDate, btn, box, msgLine); });
        unlock();
        return;
      }
      // Always re-render this card from a fresh backend read rather than
      // trusting the mutation response alone as UI state - the backend
      // stays the single source of truth even immediately after a write.
      box.removeAttribute('data-busy');
      reload();
    }).catch(function (e) {
      Net.logTech('prepare failed', e);
      showCardMessage(msgLine, Net.userMessage(e && e.kind), true, 'Retry', function () { unlock(); doPrepare(card, reviewDate, btn, box, msgLine); });
      unlock();
    });
  }

  document.getElementById('reviewDateInput').addEventListener('change', reload);

  // Restore only the LAST DATE (a convenience), then always reload from
  // the backend - never assume localStorage reflects current status.
  try {
    var savedDate = localStorage.getItem(LAST_DATE_KEY);
    if (savedDate) document.getElementById('reviewDateInput').value = savedDate;
  } catch (e) { /* ignore */ }
  // 2026-10-06 audit: control.html used to ship a hard-coded default of
  // 2026-09-01 (an old test date), so a first visit - or a browser with
  // localStorage cleared - silently opened a month-old day. Default to today
  // in the operating timezone (Asia/Riyadh) instead.
  if (!document.getElementById('reviewDateInput').value) {
    try {
      document.getElementById('reviewDateInput').value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { document.getElementById('reviewDateInput').value = new Date().toISOString().slice(0, 10); }
  }
  reload();

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

      var reviewDate = document.getElementById('reviewDateInput').value;

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
