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

  /** Expected staff vs fingerprint records vs approvals so far - shown BEFORE the employees (figures are preliminary). */
  function renderPlan(app, data) {
    var box = el('div', 'plan-box'); box.id = 'planSummary';
    box.appendChild(el('div', 'plan-title', 'Staffing plan for ' + data.zone + ' (preliminary until every record is decided)'));
    data.plan.days.forEach(function (d) {
      var exp = d.expected === null ? (d.status === 'INCOMPLETE' ? 'INCOMPLETE (known so far ' + d.knownPartial + ')' : (d.status === 'NO_ACTIVE_EVENT' ? 'no active event' : 'MISSING PLAN')) :
        String(d.expected) + (d.expectedMorning !== null && d.expectedMorning !== undefined ? ' (morning ' + d.expectedMorning + ' + night ' + d.expectedNight + ')' : '');
      var st = d.status === 'MISSING_PLAN' ? 'no plan for this day' : (d.status === 'INCOMPLETE' ? 'INCOMPLETE plan' : (d.status === 'NO_ACTIVE_EVENT' ? 'no active event' : (d.status === 'PENDING' ? 'PRELIMINARY - ' + d.pending + ' pending' : d.status === 'PRELIMINARY' ? 'PRELIMINARY - review not submitted yet' : (d.status === 'MATCHED' ? 'MATCHED' : (d.status === 'SHORTAGE' ? 'SHORTAGE ' + (-d.potentialDiff) : 'EXCESS ' + d.potentialDiff)))));
      var line = el('div', 'plan-line');
      if (data.plan.days.length > 1) line.appendChild(el('b', null, formatDay(d.date) + ': '));
      line.appendChild(el('span', 'plan-exp', 'Expected: ' + exp));
      line.appendChild(document.createTextNode(' · Fingerprints Received: ' + d.records + ' · Approved Actual: ' + d.approvedSoFar + ' · Pending: ' + d.pending +
        ' · Difference: ' + (d.potentialDiff !== null && d.potentialDiff !== undefined ? (d.potentialDiff > 0 ? '+' : '') + d.potentialDiff : '—') + ' · Status: ' + st));
      box.appendChild(line);
      if (d.planDiscrepancy) box.appendChild(el('div', 'plan-warn', 'External plan discrepancy: Approved (F) ' + (d.planApproved === null ? '—' : d.planApproved) + ' vs Scheduled (G) ' + d.planScheduled + ' - the expected figure uses Scheduled.'));
      if (d.stale) box.appendChild(el('div', 'plan-warn', 'The synced plan for this day is STALE (source or mapping changed) - the Control Center must refresh it.'));
    });
    box.appendChild(el('div', 'meta', 'Plan last synced: ' + (data.plan.lastSync || 'never') + (data.plan.freshness && data.plan.freshness !== 'OK' ? ' (' + data.plan.freshnessLabel + ')' : '') + ' · counts as of opening this page.'));
    app.appendChild(box);
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
    if (data.plan && data.plan.days && data.plan.days.length) renderPlan(app, data);

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
      if (r.changedSinceDecision === true) card.appendChild(el('div', 'plan-warn', 'Attendance changed after this decision (decided on: ' + String(r.decidedOnStatus || '') + '). Contact the office to re-confirm.'));
      if (r.hours) renderHours(card, r, data);

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

  // PHASE 7 / hours approval: working hours vs the zone's required hours (computed by the server from the zone
  // configuration). Hours are accepted automatically; the manager may confirm the recorded time, set the correct
  // working time for an event (adjust the shift), or go back to automatic approval. All of it is separate from the
  // attendance decision above. Every write returns a NEW r.hours which re-renders only this card's hours section.
  function fmtMin_(m) { var s = m < 0 ? '−' : ''; m = Math.abs(m); return s + Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2); }
  // Unicode LTR isolate: keeps numbers, times, signed differences and dates reading left-to-right inside Arabic text.
  function ltr_(x) { return '\u2066' + x + '\u2069'; }
  function fmtDiff_(m) { return m > 0 ? '+' + fmtMin_(m) : fmtMin_(m); }
  function toMin_(hhmm) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function hhmmOf_(s) { var m = /(\d{1,2}):(\d{2})\s*$/.exec(String(s || '')); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''; }
  function nextDay_(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  function newRequestId_() {
    var a = '';
    try { var u = new Uint8Array(16); window.crypto.getRandomValues(u); for (var i = 0; i < u.length; i++) a += ('0' + u[i].toString(16)).slice(-2); }
    catch (e) { a = ''; }
    if (!a) { for (var j = 0; j < 32; j++) a += Math.floor(Math.random() * 16).toString(16); }
    return 'h' + a;
  }
  function linkValid_(data) { return !data.expiresAt || new Date(data.expiresAt) > new Date(); }
  function hoursFailMsg_(res) {
    var kind = Net.classifyBackend(res);
    if (res && res.code === 'FINAL') return 'أصبح تقرير هذا اليوم نهائيًا (FINAL) ولا يمكن تعديل الساعات';
    if (res && res.code === 'NOT_COMPUTABLE') return 'بصمة الدخول أو الخروج ناقصة — لا يمكن اعتماد أو تعديل الساعات';
    if (res && res.code === 'INVALID_TIME' && res.error) return String(res.error);
    return Net.userMessage(kind, res && res.error);
  }

  function hoursLine_(h, wd) {
    var v = h.view, adj = v && v.adjusted;
    var req = adj ? (adj.required + ' (adjusted ' + adj.start + '–' + adj.end + (adj.endDate && wd && adj.endDate !== wd ? ' +1d' : '') + '; plan ' + adj.planRequired + ')') : (h.required || '—');
    var state, cls;
    if (v) {
      state = String(v.label || '') + (v.kindLabel ? ' — ' + v.kindLabel : '');
      cls = (v.status === 'MATCHED' || v.status === 'APPROVED') ? 'hours-ok' : (v.status === 'NOT_APPROVED' ? 'hours-bad' : 'hours-neutral');
    } else {
      cls = h.status === 'MATCHED' ? 'hours-ok' : (h.status === 'UNMATCHED' ? 'hours-neutral' : 'meta');
      state = h.status === 'UNMATCHED' ? String(h.category || '').replace('_', ' ') : h.status === 'MATCHED' ? 'MATCHED (within ±' + h.toleranceMin + ' min)' : String(h.status || '').replace('_', ' ');
    }
    return el('div', 'meta hours-line ' + cls, 'Hours ' + (h.actual || '—') + ' / required ' + req + (h.variance ? ' (' + h.variance + ')' : '') + ' · ' + state);
  }

  function stateLine_(h, wd) {
    var v = h.view; if (!v) return null;
    var by = v.by || '', at = v.at || '', who = ' — بواسطة ' + ltr_(by) + (at ? ' · ' + ltr_(at) : '');
    if (v.kind === 'AUTO_APPROVED') return 'الحالة: مقبول تلقائيًا (Auto-approved)';
    if (v.kind === 'MANAGER_CONFIRMED') return '✓ تم اعتماد الوقت المسجل' + who;
    if (v.kind === 'MANAGER_EXPLAINED') return '✓ معتمد بتبرير المدير — ' + ltr_(by) + (at ? ' · ' + ltr_(at) : '');
    if (v.kind === 'SHIFT_ADJUSTED') {
      var a = v.adjusted || {};
      return 'تم تعديل وقت العمل إلى ' + ltr_(a.start + '–' + a.end) + (a.endDate && wd && a.endDate !== wd ? ' (اليوم التالي)' : '') + who;
    }
    if (v.kind === 'MANAGER_REJECTED') return 'لم تُعتمد الساعات (رفض صريح)' + (v.reason ? ': ' + v.reason : '') + ' — ' + ltr_(by);
    return null;
  }

  function factsLine_(h) {
    var p = h.plan || { required: h.required, variance: h.variance };
    var t = 'الساعات المسجلة ' + ltr_(h.actual || '—') + ' · المطلوبة حسب الشفت ' + ltr_(p.required || '—') + ' · الفرق ' + ltr_(String(p.variance || '—').replace('-', '−'));
    var adj = h.view && h.view.adjusted;
    if (adj) t += ' · بعد التعديل: المطلوب ' + ltr_(adj.required) + ' · الفرق ' + ltr_(String(h.variance || '—').replace('-', '−'));
    return t;
  }

  function renderHours(card, r, data) {
    var wrap = el('div', 'hours-sec');
    card.appendChild(wrap);
    fillHours_({ card: card, wrap: wrap, r: r, data: data }, '');
  }

  function fillHours_(ctx, flash) {
    var r = ctx.r, data = ctx.data, h = r.hours, wrap = ctx.wrap, wd = h.workDate || r.workDate || '';
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(hoursLine_(h, wd));
    var valid = linkValid_(data);
    if (h.canDecide && r.decision !== 'REJECTED') wrap.appendChild(buildHoursAlert_(ctx, valid, flash));
    else if (flash) wrap.appendChild(el('div', 'meta hours-flash', flash));
    if (h.explanationRequired || h.explanationOptional) wrap.appendChild(buildExplanation_(ctx, valid));
  }

  function buildHoursAlert_(ctx, valid, flash) {
    var r = ctx.r, h = r.hours, v = h.view || {}, wd = h.workDate || r.workDate || '';
    var box = el('div', 'hours-alert'); box.setAttribute('dir', 'rtl'); box.setAttribute('lang', 'ar');
    box.appendChild(el('div', 'hours-alert-title', '⚠️ اختلاف ساعات العمل عن الشفت الأساسي'));
    box.appendChild(el('div', 'hours-alert-body', 'قد يكون الموظف مكلفًا بفعالية أو خارج الزون بأوقات مختلفة. الوقت مقبول تلقائيًا في التقرير، ويمكنك تأكيد الوقت المسجل أو تحديد وقت العمل الصحيح للفعالية.'));
    box.appendChild(el('div', 'hours-alert-facts', factsLine_(h)));
    var st = stateLine_(h, wd);
    if (st) box.appendChild(el('div', 'hours-alert-state', st));
    if (v.note) box.appendChild(el('div', 'hours-alert-note', String(v.note)));
    var msg = el('span', 'hours-alert-msg', flash || ''); msg.setAttribute('aria-live', 'polite');
    if (valid) {
      var actions = el('div', 'hours-actions');
      var confirmBtn = el('button', 'btn-success', '✓ اعتماد الوقت المسجل');
      confirmBtn.type = 'button';
      confirmBtn.addEventListener('click', function () {
        sendHours_(ctx, hoursExtra_(r, { hoursDecision: 'CONFIRM_RECORDED' }), '✓ تم اعتماد الوقت المسجل', actions, msg);
      });
      actions.appendChild(confirmBtn);
      var adjustBtn = el('button', 'btn-adjust', 'تعديل وقت العمل');
      adjustBtn.type = 'button';
      adjustBtn.addEventListener('click', function () { openAdjustModal_(ctx, adjustBtn); });
      actions.appendChild(adjustBtn);
      if ((v.source === 'MANAGER' && v.kind !== 'MANAGER_EXPLAINED') || h.decision) {
        var revertBtn = el('button', 'btn-link', '↺ العودة للاعتماد التلقائي');
        revertBtn.type = 'button';
        revertBtn.addEventListener('click', function () {
          if (!window.confirm('هل تريد العودة إلى الاعتماد التلقائي وإلغاء قرارك السابق؟')) return;
          sendHours_(ctx, hoursExtra_(r, { hoursDecision: 'REVERT_AUTO' }), '✓ تمت العودة إلى الاعتماد التلقائي', actions, msg);
        });
        actions.appendChild(revertBtn);
      }
      actions.appendChild(msg);
      box.appendChild(actions);
    } else box.appendChild(msg);
    return box;
  }

  // One request per user click: the requestId lives in the extra object, so bridgeWrite's retries re-send the SAME id.
  function hoursExtra_(r, fields) {
    // Worker rule measured 2026-11-09: modify with reason ''/null/missing -> 400 'Missing required field: reason'; ' ' is forwarded and the backend trims it to "no reason".
    var e = { employeeCode: r.employeeCode, hoursExplanation: 'true', requestId: newRequestId_(), reason: ' ' };
    if (r.workDate) e.workDate = r.workDate;
    Object.keys(fields).forEach(function (k) { e[k] = fields[k]; });
    return e;
  }

  // Shared write path. guardEl carries data-busy (double-click guard); the message is shown where the click came from.
  function sendHours_(ctx, extra, okMsg, guardEl, msgEl, hooks) {
    hooks = hooks || {};
    if (guardEl.getAttribute('data-busy') === '1') return;
    var btns = guardEl.querySelectorAll('button');
    function setBusy(on) {
      Array.prototype.forEach.call(btns, function (b) { b.disabled = on; });
      if (on) guardEl.setAttribute('data-busy', '1'); else guardEl.removeAttribute('data-busy');
      if (hooks.busy) hooks.busy(on);
    }
    setBusy(true); msgEl.textContent = 'جارٍ الحفظ…';
    bridgeWrite('modify', extra).then(function (res) {
      if (res && res.ok) {
        if (res.hours) ctx.r.hours = res.hours;
        fillHours_(ctx, okMsg); // re-render first, so the modal can return focus to the NEW adjust button
        if (hooks.done) hooks.done();
        return;
      }
      var kind = Net.classifyBackend(res || {});
      if (Net.isTerminalTokenKind(kind)) { if (hooks.done) hooks.done(); presentFailure(kind, res); return; }
      setBusy(false); msgEl.textContent = hoursFailMsg_(res || {});
    }).catch(function (e) {
      Net.logTech('hours write failed', e);
      setBusy(false); msgEl.textContent = Net.userMessage(e && e.kind, e && e.message);
      if (hooks.networkFailed) hooks.networkFailed(); else resyncAfterUncertainWrite();
    });
  }

  function openAdjustModal_(ctx, opener) {
    var r = ctx.r, h = r.hours, wd = h.workDate || r.workDate || '', nd = nextDay_(wd);
    var dec = h.decision || {}, plan = h.plan || {};
    var overlay = el('div', 'modal-overlay');
    var box = el('div', 'modal-box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('dir', 'rtl'); box.setAttribute('lang', 'ar');
    var titleId = 'adj-title-' + String(r.employeeCode).replace(/[^A-Za-z0-9_-]/g, '') + '-' + (wd || 'x'); box.setAttribute('aria-labelledby', titleId);
    var title = el('h2', 'modal-title', 'تعديل وقت العمل المطلوب'); title.id = titleId;
    box.appendChild(title);
    box.appendChild(el('div', 'modal-sub', String(r.employeeName) + ' (' + ltr_('#' + String(r.employeeCode)) + ') · يوم التشغيل: ' + ltr_(wd || '—')));

    var fStart = el('label', 'modal-field', 'وقت البداية');
    var inStart = el('input'); inStart.type = 'time'; inStart.setAttribute('dir', 'ltr'); inStart.required = true;
    inStart.value = dec.start || plan.start || hhmmOf_(h.recordedIn); fStart.appendChild(inStart); box.appendChild(fStart);
    var fEnd = el('label', 'modal-field', 'وقت النهاية');
    var inEnd = el('input'); inEnd.type = 'time'; inEnd.setAttribute('dir', 'ltr'); inEnd.required = true;
    inEnd.value = dec.end || plan.end || hhmmOf_(h.recordedOut); fEnd.appendChild(inEnd); box.appendChild(fEnd);
    var fDate = el('label', 'modal-field', 'تاريخ النهاية');
    var selDate = el('select');
    var o1 = el('option', null, 'نفس اليوم' + (wd ? ' (' + ltr_(wd) + ')' : '')); o1.value = wd || 'same';
    var o2 = el('option', null, 'اليوم التالي' + (nd ? ' (' + ltr_(nd) + ')' : '')); o2.value = nd || 'next';
    selDate.appendChild(o1); selDate.appendChild(o2); fDate.appendChild(selDate); box.appendChild(fDate);
    var fReason = el('label', 'modal-field', 'السبب');
    var reason = el('textarea'); reason.maxLength = 500; reason.rows = 2; reason.placeholder = 'سبب التعديل (اختياري) — مثال: فعالية WWE';
    reason.value = dec.reason || ''; fReason.appendChild(reason); box.appendChild(fReason);

    var preview = el('div', 'modal-preview'); preview.setAttribute('aria-live', 'polite'); box.appendChild(preview);
    var errEl = el('div', 'modal-error'); box.appendChild(errEl);
    var msg = el('div', 'modal-msg'); msg.setAttribute('aria-live', 'polite'); box.appendChild(msg);
    var actions = el('div', 'modal-actions');
    var save = el('button', 'btn-adjust', 'حفظ التعديل'); save.type = 'button';
    var cancel = el('button', 'btn-secondary', 'إلغاء'); cancel.type = 'button';
    actions.appendChild(save); actions.appendChild(cancel); box.appendChild(actions);
    overlay.appendChild(box);

    if (dec.endDate) selDate.value = dec.endDate === wd ? o1.value : o2.value;
    var userPickedDate = !!dec.endDate;

    function required() {
      var s = toMin_(inStart.value), e = toMin_(inEnd.value);
      if (s === null || e === null) return { ok: false, err: 'أدخل وقت البداية ووقت النهاية.' };
      var next = selDate.value === o2.value && o1.value !== o2.value;
      var req = (next ? 1440 : 0) + e - s;
      if (req <= 0) return { ok: false, err: 'وقت النهاية يجب أن يكون بعد وقت البداية (اختر اليوم التالي إذا عبر الوقت منتصف الليل).' };
      if (req > 1440) return { ok: false, err: 'الحد الأقصى لوقت العمل هو 24:00.' };
      return { ok: true, min: req };
    }
    function refresh() {
      var q = required();
      var actual = typeof h.actualMin === 'number' ? h.actualMin : null;
      errEl.textContent = q.ok ? '' : q.err;
      preview.textContent = q.ok ? 'الوقت المطلوب الجديد: ' + ltr_(fmtMin_(q.min)) + ' · الساعات الفعلية: ' + ltr_(actual === null ? (h.actual || '—') : fmtMin_(actual)) + ' · الفرق: ' + ltr_(actual === null ? '—' : fmtDiff_(actual - q.min)) : '';
      if (box.getAttribute('data-busy') !== '1') save.disabled = !q.ok;
      return q;
    }
    function autoDate() {
      if (userPickedDate) return;
      var s = toMin_(inStart.value), e = toMin_(inEnd.value);
      if (s !== null && e !== null && o1.value !== o2.value) selDate.value = e <= s ? o2.value : o1.value;
    }
    if (!dec.endDate) autoDate();
    ['input', 'change'].forEach(function (evn) {
      inStart.addEventListener(evn, function () { autoDate(); refresh(); });
      inEnd.addEventListener(evn, function () { autoDate(); refresh(); });
    });
    selDate.addEventListener('change', function () { userPickedDate = true; refresh(); });

    var doc = opener.ownerDocument;
    function onKey(ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); close(); return; }
      if (ev.key === 'Tab') {
        var f = Array.prototype.filter.call(box.querySelectorAll('input,select,textarea,button'), function (n) { return !n.disabled; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && doc.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && doc.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    }
    function close() {
      doc.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      var back = opener;
      if (!doc.body.contains(back)) back = ctx.wrap.querySelector('.btn-adjust') || ctx.wrap.querySelector('button');
      if (back && back.focus) back.focus();
    }
    cancel.addEventListener('click', close);
    save.addEventListener('click', function () {
      var q = refresh(); if (!q.ok) return;
      var extra = hoursExtra_(r, { hoursDecision: 'ADJUST_SHIFT', adjStart: inStart.value, adjEnd: inEnd.value, adjEndDate: (selDate.value === o2.value && o1.value !== o2.value) ? nd : wd });
      if (reason.value.trim()) extra.reason = reason.value.trim();
      sendHours_(ctx, extra, '✓ تم حفظ وقت العمل المعدل', box, msg, {
        busy: function (on) { cancel.disabled = on; if (!on) refresh(); },
        done: function () { close(); },
        networkFailed: function () { /* keep the modal open with the message; the manager can retry */ }
      });
    });
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    refresh();
    inStart.focus();
  }

  function buildExplanation_(ctx, valid) {
    var r = ctx.r, h = r.hours;
    var box = el('div', 'hours-expl');
    box.appendChild(el('div', 'meta hours-expl-title', 'Optional explanation / تبرير اختياري'));
    if (h.explanation) box.appendChild(el('div', 'meta', 'Your explanation: ' + h.explanation.decision + ' - ' + h.explanation.text + (h.explanation.at ? ' (' + h.explanation.at + ')' : '')));
    if (!valid) return box;
    var sel = el('select'); sel.setAttribute('aria-label', 'Hours decision for ' + r.employeeName);
    [['APPROVED', h.category === 'SHORT_HOURS' ? 'Approve short hours' : 'Approve extra hours'], ['REJECTED', h.category === 'SHORT_HOURS' ? 'Reject short hours' : 'Reject extra hours']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; sel.appendChild(opt);
    });
    if (h.explanation) sel.value = h.explanation.decision;
    var txt = el('input'); txt.type = 'text'; txt.maxLength = 500; txt.placeholder = 'Explanation (at least 5 characters), e.g. extended shift coverage';
    txt.setAttribute('aria-label', 'Hours explanation for ' + r.employeeName);
    if (h.explanation) txt.value = h.explanation.text;
    var save = el('button', 'btn-secondary', h.explanation ? 'Update explanation' : 'Save explanation'); save.type = 'button';
    var note = el('span', 'meta');
    save.addEventListener('click', function () {
      if (txt.value.trim().length < 5) { note.textContent = ' Please write at least 5 characters.'; txt.focus(); return; }
      save.disabled = true; note.textContent = ' Saving…';
      var extra = { employeeCode: r.employeeCode, hoursExplanation: 'true', hoursDecision: sel.value, reason: txt.value.trim() };
      if (r.workDate) extra.workDate = r.workDate;
      bridgeWrite('modify', extra).then(function (res) {
        save.disabled = false;
        if (res.ok) {
          var msg = 'Saved (' + (res.decision || sel.value) + ').';
          if (res.hours) { r.hours = res.hours; fillHours_(ctx, msg); return; }
          note.textContent = ' ' + msg; save.textContent = 'Update explanation'; return;
        }
        var kind = Net.classifyBackend(res);
        if (Net.isTerminalTokenKind(kind)) { presentFailure(kind, res); return; }
        note.textContent = ' ' + Net.userMessage(kind, res.error);
      }).catch(function (e) { save.disabled = false; Net.logTech('hours explanation failed', e); note.textContent = ' ' + Net.userMessage(e && e.kind, e && e.message); });
    });
    [sel, txt, save, note].forEach(function (n) { box.appendChild(n); });
    return box;
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
