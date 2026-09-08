(function () {
  'use strict';

  var BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.rustic-variety.workers.dev/';

  // Token lives only in a local variable from this point on - never
  // re-read from location.search again, and stripped from the visible
  // URL/history immediately so it doesn't linger in the address bar,
  // browser history, or a screen share any longer than necessary.
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  if (params.has('token')) {
    history.replaceState(null, '', location.pathname);
  }

  /** JSONP only - see the security review this POC came out of: this is
   * READ-ONLY in the intended production design (getData). The single
   * 'approve' write action here exists ONLY to prove the write path
   * conceptually against isolated TEST data; production writes are
   * expected to move to a POST-capable bridge, never GET/JSONP. */
  function jsonp(action, extraParams) {
    return new Promise(function (resolve, reject) {
      var cbName = 'cb_' + Math.random().toString(36).slice(2);
      var settled = false;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Request timed out'));
      }, 15000);

      function cleanup() {
        clearTimeout(timeoutId);
        delete window[cbName];
        if (scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
      }

      window[cbName] = function (data) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(data);
      };

      var qs = 'callback=' + encodeURIComponent(cbName) + '&token=' + encodeURIComponent(TOKEN) + '&action=' + encodeURIComponent(action);
      Object.keys(extraParams || {}).forEach(function (k) {
        qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(extraParams[k]);
      });

      var scriptEl = document.createElement('script');
      scriptEl.src = BACKEND + '?' + qs;
      scriptEl.onerror = function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Network error loading backend script'));
      };
      document.body.appendChild(scriptEl);
    });
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

  function renderData(data) {
    document.getElementById('status').textContent = '';
    var app = document.getElementById('app');
    while (app.firstChild) app.removeChild(app.firstChild); // clearing only, never inserting untrusted markup

    var meta = el('div', 'meta');
    meta.appendChild(document.createTextNode('Reviewer: '));
    meta.appendChild(el('b', null, data.reviewer));
    meta.appendChild(document.createTextNode(' · Zone: '));
    meta.appendChild(el('b', null, data.zone));
    meta.appendChild(document.createTextNode(' · Date: '));
    meta.appendChild(el('b', null, data.reviewDate));
    app.appendChild(meta);

    if (data.completed) {
      var doneBanner = el('div', 'done-banner', 'This review has been submitted. Read-only.');
      app.appendChild(doneBanner);
    }

    (data.rows || []).forEach(function (r, i) {
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
        approveBtn.addEventListener('click', function () { decide('approve', r.employeeCode, null, tag, actions); });
        actions.appendChild(approveBtn);

        var modifyBtn = el('button', 'btn-secondary', 'Modify');
        modifyBtn.addEventListener('click', function () {
          var reason = window.prompt('Reason for modifying this employee\'s status:');
          if (reason === null) return;
          if (!reason.trim()) { window.alert('A reason is required.'); return; }
          decide('modify', r.employeeCode, reason, tag, actions);
        });
        actions.appendChild(modifyBtn);

        var rejectBtn = el('button', 'btn-secondary', 'Reject');
        rejectBtn.addEventListener('click', function () {
          var reason = window.prompt('Reason for rejecting this employee\'s status:');
          if (reason === null) return;
          if (!reason.trim()) { window.alert('A reason is required.'); return; }
          decide('reject', r.employeeCode, reason, tag, actions);
        });
        actions.appendChild(rejectBtn);

        card.appendChild(actions);
      }
      app.appendChild(card);
    });

    if (!data.completed && (data.rows || []).length > 0) {
      var bulkBar = el('div', 'bulk-bar');
      var bulkBtn = el('button', 'btn-secondary', 'Bulk Approve Remaining');
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
   * URL, never a generic proxy. */
  function bridgeWrite(action, extraParams) {
    return fetch(WRITE_BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, token: TOKEN }, extraParams || {})),
    }).then(function (resp) { return resp.json(); });
  }

  function decide(action, code, reason, tagEl, actionsEl) {
    var buttons = actionsEl.querySelectorAll('button');
    buttons.forEach(function (b) { b.disabled = true; });
    var extra = { employeeCode: code };
    if (reason) extra.reason = reason;
    bridgeWrite(action, extra).then(function (res) {
      if (res.ok) {
        var label = action === 'approve' ? 'APPROVED' : action === 'modify' ? 'MODIFIED' : 'REJECTED';
        tagEl.textContent = label;
        tagEl.className = 'tag tag-' + label;
        actionsEl.parentNode.removeChild(actionsEl);
      } else {
        window.alert('Error: ' + res.error);
        buttons.forEach(function (b) { b.disabled = false; });
      }
    }).catch(function (e) {
      window.alert('Network error: ' + e.message);
      buttons.forEach(function (b) { b.disabled = false; });
    });
  }

  function bulkApprove(btn) {
    btn.disabled = true;
    btn.textContent = 'Approving remaining…';
    bridgeWrite('bulkApproveRemaining', {}).then(function (res) {
      if (res.ok) {
        jsonp('getData', {}).then(renderData);
      } else {
        window.alert('Error: ' + res.error);
        btn.disabled = false;
        btn.textContent = 'Bulk Approve Remaining';
      }
    }).catch(function (e) {
      window.alert('Network error: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Bulk Approve Remaining';
    });
  }

  function finalSubmit(btn) {
    if (!window.confirm('Submit this review as final? This cannot be changed afterward.')) return;
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    bridgeWrite('submitFinalReview', {}).then(function (res) {
      if (res.ok) {
        jsonp('getData', {}).then(renderData);
      } else {
        window.alert('Error: ' + res.error);
        btn.disabled = false;
        btn.textContent = 'Final Submit';
      }
    }).catch(function (e) {
      window.alert('Network error: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Final Submit';
    });
  }

  if (!TOKEN) {
    document.getElementById('status').textContent = 'No token in URL.';
  } else {
    jsonp('getData', {}).then(function (data) {
      if (!data.ok) { document.getElementById('status').textContent = 'Error: ' + data.error; return; }
      renderData(data);
    }).catch(function (e) {
      document.getElementById('status').textContent = 'Network error: ' + e.message;
    });
  }

  // Exposed only for the XSS regression test harness (see security
  // review) - lets a test drive renderData() with a mocked payload
  // without ever sending a malicious string through the real backend/sheet.
  window.__poc_renderData = renderData;
})();
