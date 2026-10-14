// Shared access layer for the Analytics-Admin features (Control Center Zone Operations + Period Analytics), 2026-10-14.
// It REUSES the existing, approved mechanism - nothing is bypassed and nothing new is trusted:
//   - the personal access link (?adminToken=..., the "Analytics Access Link" of Authorized_Users): held in memory for THIS
//     page load only, never stored (unchanged policy);
//   - the device credential (localStorage 'hmgAnalyticsDeviceToken'), created ONLY through the existing invite + claim
//     flow, which itself requires a valid access link; every request re-validates it server-side against live
//     Authorized_Users (Active + Analytics Admin).
// What is new: one place that tells the user what state they are in and why, a way to sign in / enroll from the page they
// are on, and a stored device credential is removed ONLY when the server definitively rejects it (it used to be wiped by
// ANY failed request in Period Analytics - one transient error silently "un-enrolled" the browser).
(function (root) {
  'use strict';
  var WORKER = 'https://hmg-write-bridge-poc.fieldmedicine1.workers.dev/';
  var KEY = 'hmgAnalyticsDeviceToken';
  var adminToken = new URLSearchParams(location.search).get('adminToken') || '';
  var listeners = [];
  var state = { code: 'CHECKING', detail: '', signedInAs: '', via: '', checkedAt: '' };

  function readDevice() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function writeDevice(t) { try { localStorage.setItem(KEY, t); return true; } catch (e) { return false; } }
  function dropDevice() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  function credential() {
    if (adminToken) return { kind: 'admin', value: adminToken };
    var d = readDevice();
    return d ? { kind: 'device', value: d } : null;
  }
  function set(code, detail, extra) {
    state = Object.assign({ code: code, detail: detail || '', signedInAs: '', via: '', checkedAt: new Date().toLocaleTimeString() }, extra || {});
    listeners.forEach(function (fn) { try { fn(state); } catch (e) { /* listener errors never break access */ } });
    return state;
  }
  /** Maps a server refusal to a user state; `definitive` = the stored device credential can never work again. */
  function classify(error, kind) {
    var e = String(error || '');
    if (/^Network error|timed out|timeout|Unexpected backend response|Failed to fetch|busy|retry|Service invoked too many times|temporarily/i.test(e)) return { code: 'SERVICE_UNAVAILABLE', definitive: false, detail: 'The server could not be reached or was busy - your access was not changed. Try again in a moment.' };
    if (/device has been revoked/i.test(e)) return { code: 'DEVICE_NOT_REGISTERED', definitive: true, detail: 'This device was revoked by an administrator. Sign in with your access link and enroll it again if you still need access here.' };
    if (/Invalid device credential|No device credential/i.test(e)) return { code: 'DEVICE_NOT_REGISTERED', definitive: true, detail: 'This browser is not enrolled (or its enrollment was removed). Sign in with your access link, then press "Remember this device".' };
    if (/deactivated/i.test(e)) return { code: 'INSUFFICIENT_PERMISSION', definitive: kind === 'device', detail: 'Your access has been deactivated in Authorized_Users. Ask the owner to reactivate it.' };
    if (/Not authorized for Period Analytics|Not authorized|Invalid or unrecognized access token/i.test(e)) {
      return kind === 'device'
        ? { code: 'SESSION_EXPIRED', definitive: true, detail: 'This device was enrolled with an access link that has since been renewed or withdrawn. Sign in with your current access link and enroll the device again.' }
        : { code: 'INSUFFICIENT_PERMISSION', definitive: false, detail: 'This access link is not valid for these features: it may have been renewed, or the account does not have the Analytics Admin role.' };
    }
    return { code: 'SERVICE_UNAVAILABLE', definitive: false, detail: 'The request failed: ' + e.slice(0, 160) };
  }
  function post(body, timeoutMs) {
    return root.HMGNet.postJson(WORKER, body, { timeoutMs: timeoutMs || 90000 })
      .then(function (r) { return r || { ok: false, error: 'Empty response.' }; }, function (e) { return { ok: false, error: 'Network error: ' + (e && e.message ? e.message : 'request failed') }; });
  }
  function todayRiyadh() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()); }
  /** Sends an Analytics-Admin request with whichever credential this page has. Handles a definitive device rejection. */
  function call(body, timeoutMs) {
    var cred = credential();
    if (!cred) { set('AUTH_REQUIRED', 'Sign in with your personal access link to use these features.'); return Promise.resolve({ ok: false, error: 'Access required.', accessState: 'AUTH_REQUIRED' }); }
    var b = Object.assign({}, body);
    if (b.action === 'periodAnalytics' && cred.kind === 'device') b.action = 'periodAnalyticsViaDevice';
    if (cred.kind === 'admin') b.adminToken = cred.value; else b.deviceToken = cred.value;
    return post(b, timeoutMs).then(function (res) {
      if (!res.ok) {
        var c = classify(res.error, cred.kind);
        if (c.definitive && cred.kind === 'device') dropDevice(); // only a definitive rejection removes the enrollment
        if (c.code !== 'SERVICE_UNAVAILABLE') set(c.code, c.detail); // validation / transient errors never change the access state
        res.accessState = c.code;
      }
      return res;
    });
  }
  /** Asks the server who this credential is (Zone Operations accessStatus; masked identity only). */
  function check() {
    var cred = credential();
    if (!cred) return Promise.resolve(set('AUTH_REQUIRED', 'Sign in with your personal access link (the "Analytics Access Link" you received). Then press "Remember this device" so you do not need the link again on this browser.'));
    set('CHECKING', 'Checking your access…');
    var d = todayRiyadh();
    return call({ action: 'periodAnalytics', op: 'accessStatus', date: d, fromDate: d, toDate: d }).then(function (res) {
      if (res.ok) return set('AUTHORIZED', cred.kind === 'admin' ? 'Signed in with your access link - for this page only (a refresh or new tab will ask again unless you remember this device).' : 'This browser is enrolled - access works here without the link.',
        { signedInAs: res.signedInAs || '', via: cred.kind });
      var c = classify(res.error, cred.kind);
      return set(c.code, c.detail);
    });
  }
  /** Uses a pasted access link (or the bare token) for THIS page load - never stored. */
  function useAccessLink(text) {
    var s = String(text || '').trim(), m = /[?&]adminToken=([^&#\s]+)/.exec(s);
    var tok = m ? decodeURIComponent(m[1]) : s;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(tok)) return false;
    adminToken = tok;
    return true;
  }
  /** The existing enrollment: a single-use invite minted with the access link, claimed immediately by THIS browser. */
  function enrollThisDevice() {
    if (!adminToken) return Promise.resolve({ ok: false, error: 'Sign in with your access link first - enrollment needs it once.' });
    return post({ action: 'createAnalyticsInvite', adminToken: adminToken }, 120000).then(function (inv) {
      if (!inv.ok) return { ok: false, error: inv.error || 'Could not create the enrollment.' };
      return post({ action: 'claimAnalyticsInvite', inviteToken: inv.inviteToken, deviceLabel: navigator.userAgent.slice(0, 120) }, 120000).then(function (cl) {
        if (!cl.ok || !cl.deviceToken) return { ok: false, error: cl.error || 'Could not complete the enrollment.' };
        if (!writeDevice(cl.deviceToken)) return { ok: false, error: 'This browser blocks local storage (private mode?) - enrollment cannot be remembered here.' };
        return { ok: true };
      });
    });
  }
  function forgetThisDevice() { dropDevice(); return check(); }

  root.HMGAccess = {
    credential: credential, call: call, check: check, classify: classify, useAccessLink: useAccessLink, enrollThisDevice: enrollThisDevice,
    forgetThisDevice: forgetThisDevice, hasDevice: function () { return !!readDevice(); }, hasAccessLink: function () { return !!adminToken; },
    state: function () { return state; }, onChange: function (fn) { listeners.push(fn); }, todayRiyadh: todayRiyadh,
  };
})(window);
