(function () {
  'use strict';

  var BACKEND = 'https://script.google.com/macros/s/AKfycbxcVYWRoQRe429lHHZsReYvJ3qVmD-EAK2WdWtY51iXxX0YOuW1-FqlAfd-1-AjdSpD/exec';
  var WRITE_BRIDGE = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';

  // Kept in this page's own localStorage - never sent anywhere except
  // back to this same backend, never shown to the reviewer (the reviewer
  // only ever receives the plain manager URL, exactly as the real
  // product's WhatsApp link works). Persisted (not just in-memory) so
  // reloading this Control Center page can still check status without
  // minting a new assignment - see requirement "refresh status without
  // recreating the assignment".
  var STORAGE_KEY = 'hmgControlState';
  var state = { token: null, managerUrl: null, expiresAt: null, baselinePending: null, reviewer: null, whatsapp: null, zone: null, reviewDate: null };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.token) state = saved;
  } catch (e) { /* private browsing or corrupted value - start fresh */ }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
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

  // Shown on the control page only (never sent anywhere) - shoulder-surf
  // protection. The real number is still used, unmasked, to build the
  // WhatsApp link itself; masking is a display-only precaution.
  function maskPhone(raw) {
    var s = String(raw || '');
    return s.length > 2 ? s.slice(0, -4).replace(/./g, '*') + s.slice(-4) : s;
  }

  // wa.me needs the full international number, digits only, no leading
  // zero or plus. Saudi numbers in the sheet may be stored as a local
  // 05XXXXXXXX number, a bare 5XXXXXXXX, or already-international -
  // normalize all three to the one form wa.me accepts.
  function normalizeSaudiPhone(raw) {
    var digits = String(raw || '').replace(/[^0-9]/g, '');
    if (digits.indexOf('00') === 0) digits = digits.slice(2);
    if (digits.indexOf('966') === 0) return digits;
    if (digits.indexOf('0') === 0) return '966' + digits.slice(1);
    if (digits.length === 9) return '966' + digits;
    return digits;
  }

  // OPENED means the reviewer has loaded the page but decided
  // nothing yet; IN PROGRESS means at least one decision has been made
  // this cycle. We only know "this cycle's" pending baseline from the
  // very first status check right after Prepare, so record it then.
  function classify(data) {
    if (state.expiresAt && new Date(state.expiresAt) < new Date()) return 'EXPIRED';
    if (data.completed) return 'COMPLETED';
    if (!data.lastAccessed) return 'PREPARED';
    var pendingCount = (data.rows || []).filter(function (r) { return r.decision === 'PENDING'; }).length;
    if (state.baselinePending === undefined || state.baselinePending === null) { state.baselinePending = pendingCount; saveState(); }
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
    document.getElementById('reviewerName').textContent = state.reviewer;
    document.getElementById('waMasked').textContent = maskPhone(state.whatsapp);
    document.getElementById('resolvedZone').textContent = state.zone === 'ALL' ? 'All Zones (Doctors)' : state.zone;
    document.getElementById('resolvedDate').textContent = state.reviewDate;
    document.getElementById('urlBox').textContent = state.managerUrl;
    document.getElementById('expiryLine').textContent = 'Expires: ' + new Date(state.expiresAt).toLocaleString() + ' (exactly 24 hours after Prepare)';
    var waText = encodeURIComponent('HMG Attendance Review — please review: ' + state.managerUrl);
    document.getElementById('whatsappBtn').onclick = function () {
      window.open('https://wa.me/' + normalizeSaudiPhone(state.whatsapp) + '?text=' + waText, '_blank');
    };
    var tag = document.getElementById('statusTag');
    tag.textContent = 'PREPARED';
    tag.className = 'tag tag-PREPARED';
  }

  // Doctors scope is always "all zones" server-side (matches production's
  // Routing.gs) - the Zone selector is irrelevant for that type, so it's
  // disabled rather than sent-but-ignored, to avoid implying it matters.
  document.getElementById('typeSelect').addEventListener('change', function () {
    var isDoctors = this.value === 'DOCTORS';
    document.getElementById('zoneSelect').disabled = isDoctors;
    document.getElementById('zoneField').style.opacity = isDoctors ? '0.5' : '1';
  });

  document.getElementById('prepareBtn').addEventListener('click', function () {
    var btn = this;
    var reviewType = document.getElementById('typeSelect').value;
    var zone = document.getElementById('zoneSelect').value;
    var reviewDate = document.getElementById('reviewDateInput').value;
    if (!reviewDate) { setMsg('Review Date is required.'); return; }

    btn.disabled = true;
    btn.textContent = 'Preparing…';
    setMsg('');
    var payload = { reviewDate: reviewDate, reviewType: reviewType };
    if (reviewType === 'ZONE') payload.zone = zone;
    bridgePost('prepareReview', payload).then(function (res) {
      btn.disabled = false;
      btn.textContent = 'Prepare Review';
      if (!res.ok) {
        // No sheet write happened on a routing failure (no active route /
        // ambiguous route) - the error is shown as-is, never guessed past.
        setMsg('Error: ' + res.error);
        document.getElementById('resultCard').hidden = true;
        return;
      }
      state.token = res.token;
      state.managerUrl = res.managerUrl;
      state.expiresAt = res.expiresAt;
      state.reviewer = res.reviewer;
      state.whatsapp = res.whatsapp;
      state.zone = res.zone;
      state.reviewDate = res.reviewDate;
      state.baselinePending = null;
      saveState();
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

  // Restore a previously-prepared assignment on reload, so the preparer
  // can come back and check status without minting a fresh token.
  if (state.token) {
    showResult();
    checkStatus(state.token).then(function (data) {
      if (data && data.ok) renderStatus(data);
    }).catch(function () { /* leave the PREPARED default shown */ });
  }
})();
