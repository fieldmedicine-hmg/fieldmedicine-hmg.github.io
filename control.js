(function () {
  'use strict';

  var BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';

  // Kept only in this page's own memory - never persisted, never shown to
  // the reviewer. The reviewer only ever receives the plain manager URL
  // (which already carries the token as its one query param), exactly as
  // the real product's WhatsApp link works.
  var state = { token: null, managerUrl: null, expiresAt: null };

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

  // The one CONTROL-side mutation (mint/reset) - POST-only, through the
  // same Worker bridge as every reviewer write action, never a bare GET.
  function bridgePost(action, extra) {
    return fetch(WRITE_BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    }).then(function (r) { return r.json(); });
  }

  // source: 'control' tells the backend this is the preparer checking
  // status, not the reviewer opening the link - it must NOT bump the
  // "Last Accessed" bookkeeping the reviewer page's own reads do, or the
  // status here would falsely jump to OPENED before the reviewer ever
  // taps the link themselves.
  function checkStatus(token) {
    return jsonpGet('getData', { token: token, source: 'control' });
  }

  function setMsg(text) { document.getElementById('statusMsg').textContent = text || ''; }

  // OPENED means the reviewer has loaded the page but decided
  // nothing yet; IN PROGRESS means at least one decision has been made
  // this cycle. We only know "this cycle's" pending baseline from the
  // very first status check right after Prepare, so record it then.
  function classify(data) {
    if (state.expiresAt && new Date(state.expiresAt) < new Date()) return 'EXPIRED';
    if (data.completed) return 'COMPLETED';
    if (!data.lastAccessed) return 'PREPARED';
    var pendingCount = (data.rows || []).filter(function (r) { return r.decision === 'PENDING'; }).length;
    if (state.baselinePending === undefined || state.baselinePending === null) state.baselinePending = pendingCount;
    return pendingCount < state.baselinePending ? 'IN_PROGRESS' : 'OPENED';
  }

  function renderStatus(data) {
    var status = classify(data);
    var tag = document.getElementById('statusTag');
    tag.textContent = status.replace('_', ' ');
    tag.className = 'tag tag-' + status;
  }

  function showResult() {
    document.getElementById('resultCard').hidden = false;
    document.getElementById('urlBox').textContent = state.managerUrl;
    document.getElementById('expiryLine').textContent = 'Expires: ' + new Date(state.expiresAt).toLocaleString() + ' (exactly 24 hours after Prepare)';
    var waText = encodeURIComponent('HMG Attendance Review — please review: ' + state.managerUrl);
    document.getElementById('whatsappBtn').onclick = function () {
      window.open('https://wa.me/?text=' + waText, '_blank');
    };
    var tag = document.getElementById('statusTag');
    tag.textContent = 'PREPARED';
    tag.className = 'tag tag-PREPARED';
  }

  document.getElementById('prepareBtn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    setMsg('');
    bridgePost('prepareReview', {}).then(function (res) {
      btn.disabled = false;
      btn.textContent = 'Prepare Review';
      if (!res.ok) { setMsg('Error: ' + res.error); return; }
      state.token = res.token;
      state.managerUrl = res.managerUrl;
      state.expiresAt = res.expiresAt;
      state.baselinePending = null;
      showResult();
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Prepare Review';
      setMsg('Network error: ' + e.message);
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', function () {
    if (!state.token) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    checkStatus(state.token).then(function (data) {
      btn.disabled = false;
      btn.textContent = 'Refresh Status';
      if (!data.ok) { setMsg('Error: ' + data.error); return; }
      renderStatus(data);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Refresh Status';
      setMsg('Network error: ' + e.message);
    });
  });
})();
