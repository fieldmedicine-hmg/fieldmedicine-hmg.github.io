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
  function scopeLabel(card) {
    return card.reviewType === 'DOCTORS' ? 'All Zones' : 'Zone Staff';
  }
  function countLabel(card) {
    return card.count + (card.reviewType === 'DOCTORS' ? (card.count === 1 ? ' doctor' : ' doctors') : (card.count === 1 ? ' employee' : ' employees'));
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
    box.appendChild(el('div', 'meta', scopeLabel(card) + ' · ' + countLabel(card)));

    if (card.routingError) {
      box.appendChild(el('div', 'meta', 'Reviewer: —'));
      var errLine = el('div', 'routing-error', card.routingError.indexOf('ambiguity') !== -1 ? 'Routing ambiguity' : 'Reviewer not configured');
      box.appendChild(errLine);
      return box;
    }

    box.appendChild(el('div', 'meta', 'Reviewer: ' + card.reviewer));
    if (card.whatsapp) box.appendChild(el('div', 'meta', 'WhatsApp: ' + maskPhone(card.whatsapp)));

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
})();
