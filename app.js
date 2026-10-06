(function () {
  'use strict';

  var BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';
  var Net = window.HMGNet;

  // Timeouts (2026-10-06 audit). Measured backend response times for these
  // calls are 2-9s; the ceilings leave generous margin without letting a
  // stalled request keep the page on "Loading..." forever.
  var READ_TIMEOUT_MS = 25000;
  var WRITE_TIMEOUT_MS = 45000;

  // TEST-only rough timing instrumentation (console only, never shown to
  // the reviewer) - per-request start times keyed by label, logged as
  // "TIMING <label> <ms>" so they can be read back from the console
  // during verification. Not a profiler, just wall-clock elapsed time
  // for "how long did this feel" reporting.
  function timeStart() { return performance.now(); }
  function timeEnd(label, start) { console.log('TIMING ' + label + ' ' + Math.round(performance.now() - start) + 'ms'); }

  // 2026-09-28 reliability fix: a real reviewer opening this page on
  // mobile (Samsung Internet / Chrome Android both suspend and restore
  // background tabs by URL) would previously see "No token in URL." on
  // any reload or tab restore - the token was captured into TOKEN
  // correctly on first load, but was ALSO erased from the visible URL/
  // history at that exact moment (see below), so a later reload had
  // nothing left to read. sessionStorage closes that gap as a pure
  // reload/tab-resume mechanism - never a security boundary; the
  // backend still validates the token on every single protected request
  // exactly as before, and this key clears the moment the tab/browser
  // session ends (never localStorage, which would outlive the session).
  //
  // ONE bootstrap, one priority order, used everywhere TOKEN is read:
  //   1. `?token=` in the URL, PRESENT (regardless of value) - always
  //      wins, always replaces whatever was previously stored. A blank
  //      `?token=` is a deliberate "no token" signal, not "keep using
  //      the old session" - opening a stripped/malformed link must
  //      never silently fall through to a stale valid session.
  //   2. No `token` param at all - sessionStorage, the reload/tab-
  //      restore fallback (this is the ONLY case that consults it).
  //   3. Neither - missing, handled explicitly below, never granted.
  var SESSION_TOKEN_KEY_ = 'hmgReviewToken';
  function readStoredToken_() { try { return sessionStorage.getItem(SESSION_TOKEN_KEY_) || ''; } catch (e) { return ''; } }
  function storeToken_(t) { try { sessionStorage.setItem(SESSION_TOKEN_KEY_, t); } catch (e) { /* private mode etc. - falls back to URL-only for this load */ } }
  function clearStoredToken_() { try { sessionStorage.removeItem(SESSION_TOKEN_KEY_); } catch (e) { /* ignore */ } }

  // Removes ONLY the `token` param, preserving every other query param
  // and the hash fragment - never collapses the URL down to the bare
  // path (a `?source=whatsapp` or `#section` some future caller adds
  // must survive sanitization untouched).
  function stripTokenFromUrl_() {
    var url = new URL(location.href);
    url.searchParams.delete('token');
    var qs = url.searchParams.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  var params = new URLSearchParams(location.search);
  var hasUrlToken = params.has('token');
  var urlToken = params.get('token') || '';
  if (hasUrlToken) stripTokenFromUrl_();

  var TOKEN;
  if (hasUrlToken) {
    if (urlToken) {
      TOKEN = urlToken;
      storeToken_(TOKEN);
    } else {
      // `?token=` present but blank - explicit "no token", not "use the
      // old one". Drops any previously stored session outright.
      TOKEN = '';
      clearStoredToken_();
    }
  } else {
    TOKEN = readStoredToken_();
  }

  /** Small DOM builder - every value that could ever originate from a
   * spreadsheet cell goes through .textContent (or is passed to
   * document.createTextNode), never through innerHTML/outerHTML. There
   * is deliberately no "escape and concatenate into an HTML string"
   * helper anywhere in this file - that pattern is exactly what caused
   * the earlier reviewed XSS gap, and textContent makes the same mistake
   * structurally impossible rather than relying on remembering to escape. */
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /** Decision only ever drives a CSS class name (never HTML), but stay
   * defensive anyway: an unexpected value falls back to a visibly-flagged
   * class instead of being concatenated unchecked. */
  function decisionClass(v) {
    var s = String(v == null ? '' : v);
    return /^[A-Za-z0-9_-]+$/.test(s) ? s : 'UNKNOWN';
  }

  // ---------- status area (loading / errors / retry) ----------
  function statusEl() { return document.getElementById('status'); }
  function setStatus(text) {
    var s = statusEl();
    while (s.firstChild) s.removeChild(s.firstChild);
    s.textContent = text || '';
  }
  function setStatusWithRetry(text, onRetry) {
    var s = statusEl();
    while (s.firstChild) s.removeChild(s.firstChild);
    s.appendChild(document.createTextNode(text + ' '));
    var b = el('button', 'btn-primary', 'Retry');
    b.addEventListener('click', function () { b.disabled = true; onRetry(); });
    s.appendChild(b);
  }

  /** The ONE place a backend/transport failure becomes something the person
   * sees. Terminal token problems end the session (no retry button, stored
   * token dropped); transient ones offer Retry. Technical detail -> console. */
  function presentFailure(kindOrErr, backendBody, retryFn) {
    var kind = typeof kindOrErr === 'string' ? kindOrErr : (kindOrErr && kindOrErr.kind) || 'BACKEND';
    if (kindOrErr && typeof kindOrErr !== 'string') Net.logTech('request failed', kindOrErr);
    else Net.logTech('backend refused', { kind: kind, message: backendBody && backendBody.error });
    var msg = Net.userMessage(kind, backendBody && backendBody.error);
    if (Net.isTerminalTokenKind(kind)) {
      clearStoredToken_();
      var app = document.getElementById('app');
      while (app.firstChild) app.removeChild(app.firstChild);
      setStatus(msg);
      return msg;
    }
    if (retryFn) setStatusWithRetry(msg, retryFn);
    else setStatus(msg);
    return msg;
  }

  function jsonpGetData(onSlow) {
    return Net.withRetry(function () {
      return Net.jsonp(BACKEND, { token: TOKEN, action: 'getData' }, { timeoutMs: READ_TIMEOUT_MS, onSlow: onSlow });
    }, { retries: 2, baseMs: 1500 });
  }

  function renderData(data) {
    setStatus('');
    var app = document.getElementById('app');
    while (app.firstChild) app.removeChild(app.firstChild); // clearing only, never inserting untrusted markup

    var meta = el('div', 'meta');
    meta.appendChild(document.createTextNode('Reviewer: '));
    meta.appendChild(el('b', null, data.reviewer));
    meta.appendChild(document.createTextNode(' · Zone: '));
    meta.appendChild(el('b', null, data.zone));
    meta.appendChild(document.createTextNode(data.periodStart ? ' · Period: ' : ' · Date: '));
    meta.appendChild(el('b', null, data.reviewDate));
    app.appendChild(meta);

    if (data.completed) {
      var doneBanner = el('div', 'done-banner', 'This review has been submitted. Read-only.');
      app.appendChild(doneBanner);
    }

    var lastDay = null;
    (data.rows || []).forEach(function (r, i) {
      // A period review lists several days: one header per day (rows arrive ordered by day).
      if (r.workDate && r.workDate !== lastDay) {
        lastDay = r.workDate;
        app.appendChild(el('div', 'day-header', formatDay(r.workDate)));
      }
      var card = el('div', 'emp-card');
      card.id = 'row-' + i;

      var top = el('div', 'emp-top');
      top.appendChild(el('span', 'emp-name', String(r.employeeName)));
      top.appendChild(el('span', 'emp-code', '#' + String(r.employeeCode)));
      var tag = el('span', 'tag tag-' + decisionClass(r.decision), String(r.decision));
      tag.id = 'tag-' + i;
      top.appendChild(tag);
      card.appendChild(top);

      var metaLine = el('div', 'meta', [r.designation, r.event, 'Check-in ' + r.checkin, 'Check-out ' + r.checkout, r.status].join(' · '));
      card.appendChild(metaLine);

      if (r.decision === 'PENDING' && !data.completed) {
        var actions = el('div', 'row-actions');

        var approveBtn = el('button', null, 'Approve');
        approveBtn.addEventListener('click', function () { decide('approve', r.employeeCode, null, tag, actions, r.workDate); });
        actions.appendChild(approveBtn);

        var modifyBtn = el('button', 'btn-secondary', 'Modify');
        modifyBtn.addEventListener('click', function () {
          var reason = window.prompt('Reason for modifying this employee\'s status:');
          if (reason === null) return;
          if (!reason.trim()) { window.alert('A reason is required.'); return; }
          decide('modify', r.employeeCode, reason, tag, actions, r.workDate);
        });
        actions.appendChild(modifyBtn);

        var rejectBtn = el('button', 'btn-secondary', 'Reject');
        rejectBtn.addEventListener('click', function () {
          var reason = window.prompt('Reason for rejecting this employee\'s status:');
          if (reason === null) return;
          if (!reason.trim()) { window.alert('A reason is required.'); return; }
          decide('reject', r.employeeCode, reason, tag, actions, r.workDate);
        });
        actions.appendChild(rejectBtn);

        card.appendChild(actions);
      }
      app.appendChild(card);
    });

    if (!data.completed && (data.rows || []).length > 0) {
      var bulkBar = el('div', 'bulk-bar');
      var bulkBtn = el('button', 'btn-secondary', 'Approve All Remaining');
      bulkBtn.addEventListener('click', function () { bulkApprove(bulkBtn); });
      bulkBar.appendChild(bulkBtn);

      var submitBtn = el('button', 'btn-primary', 'Final Submit');
      submitBtn.addEventListener('click', function () { finalSubmit(submitBtn); });
      bulkBar.appendChild(submitBtn);

      app.appendChild(bulkBar);
    }
  }

  /** Writes go through the POST-capable Worker bridge, never JSONP/GET -
   * see the security review this POC came out of. A real fetch() POST,
   * same-origin-checked by the Worker (Access-Control-Allow-Origin
   * locked to this exact page's origin), never a client-supplied target
   * URL, never a generic proxy.
   *
   * 2026-10-06 audit: hard timeout + bounded retry. Retrying is safe: the
   * backend treats an identical repeat of Approve/Modify/Reject, Approve
   * All Remaining and Final Submit as a no-op (idempotent), so a response
   * lost in transit can be re-sent without creating a duplicate decision. */
  function bridgeWrite(action, extraParams) {
    return Net.withRetry(function () {
      return Net.postJson(WRITE_BRIDGE, Object.assign({ action: action, token: TOKEN }, extraParams || {}), { timeoutMs: WRITE_TIMEOUT_MS });
    }, { retries: 2, baseMs: 1500 });
  }

  /** After a write whose outcome we could not confirm (timeout/network even
   * after retries) show the user the REAL saved state instead of guessing. */
  function resyncAfterUncertainWrite() {
    jsonpGetData().then(function (data) {
      if (data && data.ok) { renderData(data); setStatus('We could not confirm your last action, so the page was refreshed with what is saved.'); }
    }).catch(function () { /* still offline - the alert already told the user */ });
  }

  function formatDay(ymd) {
    try { return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
    catch (e) { return String(ymd); }
  }

  function decide(action, code, reason, tagEl, actionsEl, workDate) {
    var buttons = actionsEl.querySelectorAll('button');
    if (actionsEl.getAttribute('data-busy') === '1') return; // double-click guard
    actionsEl.setAttribute('data-busy', '1');
    buttons.forEach(function (b) { b.disabled = true; });
    var extra = { employeeCode: code };
    if (reason) extra.reason = reason;
    if (workDate) extra.workDate = workDate; // period reviews only; a one-day link never sends it
    var t0 = timeStart();
    bridgeWrite(action, extra).then(function (res) {
      timeEnd(action, t0);
      if (res.ok) {
        var label = action === 'approve' ? 'APPROVED' : action === 'modify' ? 'MODIFIED' : 'REJECTED';
        tagEl.textContent = label;
        tagEl.className = 'tag tag-' + label;
        actionsEl.parentNode.removeChild(actionsEl);
      } else {
        var kind = Net.classifyBackend(res);
        // The token can expire/be revoked between page load and a write
        // (a reviewer who leaves the tab open past expiry) - only drop
        // the stored session if THIS was that terminal case, never for
        // an ordinary write failure ("already submitted", busy, etc).
        if (Net.isTerminalTokenKind(kind)) { presentFailure(kind, res); return; }
        window.alert(Net.userMessage(kind, res.error));
        actionsEl.removeAttribute('data-busy');
        buttons.forEach(function (b) { b.disabled = false; });
      }
    }).catch(function (e) {
      Net.logTech('write failed: ' + action, e);
      window.alert(Net.userMessage(e && e.kind, e && e.message));
      actionsEl.removeAttribute('data-busy');
      buttons.forEach(function (b) { b.disabled = false; });
      resyncAfterUncertainWrite();
    });
  }

  function bulkApprove(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Approving remaining…';
    var t0 = timeStart();
    bridgeWrite('bulkApproveRemaining', {}).then(function (res) {
      timeEnd('bulkApproveRemaining', t0);
      if (res.ok) {
        return jsonpGetData().then(function (data) {
          if (data && data.ok) { renderData(data); setStatus(res.approvedCount + ' remaining record(s) approved.'); }
          else presentFailure(Net.classifyBackend(data || {}), data, loadReview);
        });
      }
      var kind = Net.classifyBackend(res);
      if (Net.isTerminalTokenKind(kind)) { presentFailure(kind, res); return; }
      window.alert(Net.userMessage(kind, res.error));
      btn.disabled = false;
      btn.textContent = 'Approve All Remaining';
    }).catch(function (e) {
      Net.logTech('bulk approve failed', e);
      window.alert(Net.userMessage(e && e.kind, e && e.message));
      btn.disabled = false;
      btn.textContent = 'Approve All Remaining';
      resyncAfterUncertainWrite();
    });
  }

  function finalSubmit(btn) {
    if (btn.disabled) return;
    if (!window.confirm('Submit this review as final? This cannot be changed afterward.')) return;
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    var t0 = timeStart();
    bridgeWrite('submitFinalReview', {}).then(function (res) {
      timeEnd('submitFinalReview', t0);
      if (res.ok) {
        return jsonpGetData().then(function (data) {
          if (data && data.ok) renderData(data);
          else presentFailure(Net.classifyBackend(data || {}), data, loadReview);
        });
      }
      var kind = Net.classifyBackend(res);
      if (Net.isTerminalTokenKind(kind)) { presentFailure(kind, res); return; }
      // e.g. PENDING_REMAINING: the backend says exactly how many are left.
      window.alert(Net.userMessage(kind, res.error));
      btn.disabled = false;
      btn.textContent = 'Final Submit';
    }).catch(function (e) {
      Net.logTech('final submit failed', e);
      window.alert(Net.userMessage(e && e.kind, e && e.message));
      btn.disabled = false;
      btn.textContent = 'Final Submit';
      resyncAfterUncertainWrite();
    });
  }

  function loadReview() {
    if (!TOKEN) {
      // Reached ONLY when neither the URL nor sessionStorage has a token -
      // a genuinely fresh tab/session with no review link ever opened in
      // it (requirement: closing the browser and later opening the bare
      // site root must never magically grant access). Distinct wording
      // from a backend rejection below - this one never reached the
      // backend at all.
      setStatus(Net.userMessage('TOKEN_MISSING'));
      return;
    }
    setStatus('Loading your review…');
    var loadT0 = timeStart();
    jsonpGetData(function () { setStatus('Still loading… this can take a few more seconds.'); }).then(function (data) {
      timeEnd('initialLoad', loadT0);
      if (!data.ok) {
        // Only a TERMINAL token rejection drops the stored session - a
        // transient failure (busy/retryable lock, a caught internal
        // error) must never destroy a still-valid review session over a
        // momentary backend hiccup; reloading should just retry it.
        presentFailure(Net.classifyBackend(data), data, loadReview);
        return;
      }
      renderData(data);
    }).catch(function (e) {
      // A timeout/network failure is NOT proof the token is bad - keep
      // it stored so retrying (once connectivity is back) uses the same
      // session rather than dead-ending into "link is missing".
      presentFailure(e, null, loadReview);
    });
  }

  loadReview();

  // Exposed only for the XSS regression test harness (see security
  // review) - lets a test drive renderData() with a mocked payload
  // without ever sending a malicious string through the real backend/sheet.
  window.__poc_renderData = renderData;
})();
