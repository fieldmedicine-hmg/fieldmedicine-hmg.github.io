/**
 * Shared network layer for every page (2026-10-06 production audit).
 *
 * Why this exists: each page used its own bare fetch()/JSONP code. A bare
 * fetch() has NO timeout, so a stalled Worker/Google redirect left the UI on
 * "Loading..." forever; failures were reported as one generic string; and
 * nothing distinguished a request that can never succeed (revoked link)
 * from one worth retrying (timeout). This module gives all pages the same
 * rules:
 *
 *   - every request has a hard timeout (AbortController / script timer);
 *   - failures are CLASSIFIED: TIMEOUT, NETWORK, HTTP, BAD_RESPONSE, or a
 *     BACKEND error mapped from the backend's `code` (or, for older backend
 *     builds, its exact message string);
 *   - retries are bounded, exponential, and ONLY for retryable kinds -
 *     terminal token errors (invalid / expired / revoked / completed) never
 *     enter a retry loop;
 *   - user-facing text never carries internals; technical detail goes to the
 *     console only.
 *
 * Plain ES5, no dependencies. Works in the browser (window.HMGNet) and in
 * Node (module.exports) so tools/net-test.js can unit-test it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HMGNet = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- error model ----------
  function NetError(kind, message, extra) {
    var e = new Error(message || kind);
    e.name = 'NetError';
    e.kind = kind;
    e.retryable = false;
    Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  // Kinds a retry can plausibly fix.
  var RETRYABLE_KINDS = { TIMEOUT: true, NETWORK: true, HTTP_5XX: true, HTTP_429: true, BUSY: true, BAD_RESPONSE_TRANSIENT: true };

  // Backend `code` values (new builds) and exact legacy messages (older
  // builds / the Worker's own pre-check) -> kind.
  var CODE_TO_KIND = {
    INVALID_TOKEN: 'TOKEN_INVALID', MISSING_TOKEN: 'TOKEN_MISSING', EXPIRED: 'TOKEN_EXPIRED', REVOKED: 'TOKEN_REVOKED',
    ALREADY_SUBMITTED: 'ALREADY_SUBMITTED', COMPLETED: 'ALREADY_SUBMITTED', PENDING_REMAINING: 'PENDING_REMAINING',
    FORBIDDEN: 'PERMISSION', REASON_REQUIRED: 'VALIDATION', INVALID_REQUEST: 'VALIDATION', OUT_OF_SCOPE: 'VALIDATION',
    NO_ASSIGNMENT: 'NO_ASSIGNMENT', NOT_REISSUABLE: 'NOT_REISSUABLE', ROUTING: 'ROUTING', SERVER_ERROR: 'SERVER', UNKNOWN_ACTION: 'SERVER',
  };
  var MESSAGE_TO_KIND = {
    'Invalid link.': 'TOKEN_INVALID',
    'This link has expired.': 'TOKEN_EXPIRED',
    'This link has been revoked.': 'TOKEN_REVOKED',
    'Missing/invalid token': 'TOKEN_MISSING',
    'This review has already been submitted and is read-only.': 'ALREADY_SUBMITTED',
    'System is busy processing another request for this assignment. Please retry in a moment.': 'BUSY',
    // The Worker's own answer when the Apps Script hop returned something that was not JSON (a Google
    // redirect/HTML hiccup, measured at ~5% of calls). Transient: retried wherever the caller allows retries.
    'Unexpected backend response': 'BAD_RESPONSE_TRANSIENT',
  };
  var TERMINAL_TOKEN_KINDS = { TOKEN_INVALID: true, TOKEN_MISSING: true, TOKEN_EXPIRED: true, TOKEN_REVOKED: true };

  /** Maps a backend {ok:false,...} body to a NetError-shaped kind. */
  function classifyBackend(body) {
    if (!body || typeof body !== 'object') return 'BAD_RESPONSE';
    if (body.retryable === true) return 'BUSY';
    if (body.code && CODE_TO_KIND[body.code]) return CODE_TO_KIND[body.code];
    if (body.error && MESSAGE_TO_KIND[body.error]) return MESSAGE_TO_KIND[body.error];
    return 'BACKEND';
  }
  function isTerminalTokenKind(kind) { return !!TERMINAL_TOKEN_KINDS[kind]; }
  function isRetryableKind(kind) { return !!RETRYABLE_KINDS[kind]; }

  /** What the person sees. Never includes URLs, tokens, stack traces. */
  function userMessage(kind, backendError) {
    switch (kind) {
      case 'TIMEOUT': return 'The request took too long to respond. Please check your connection and try again.';
      case 'NETWORK': return 'Could not reach the server. Please check your internet connection and try again.';
      case 'HTTP_5XX': case 'HTTP_429': return 'The service is temporarily unavailable. Please try again in a moment.';
      case 'HTTP': return 'The service returned an unexpected response. Please try again.';
      case 'BAD_RESPONSE': case 'BAD_RESPONSE_TRANSIENT': return 'The service returned an unreadable response. Please try again.';
      case 'BUSY': return 'The system is busy with another request. Please try again in a moment.';
      case 'TOKEN_INVALID': return 'This review link is not valid. It may have been replaced by a newer link - ask the office to resend it.';
      case 'TOKEN_MISSING': return 'The review link is incomplete. Please open the full link from your WhatsApp message again.';
      case 'TOKEN_EXPIRED': return 'This review link has expired. Ask the office to resend it.';
      case 'TOKEN_REVOKED': return 'This review link has been revoked. Please contact the office.';
      case 'ALREADY_SUBMITTED': return backendError || 'This review was already submitted.';
      case 'PENDING_REMAINING': return backendError || 'Some records are still pending.';
      case 'PERMISSION': return 'This action is not permitted.';
      case 'NO_ASSIGNMENT': return 'This review has not been prepared yet. Use Prepare first.';
      case 'NOT_REISSUABLE': return backendError || 'This review link cannot be reissued right now.';
      case 'ROUTING': return backendError || 'No reviewer is configured for this group.';
      case 'VALIDATION': return backendError || 'The request was not accepted.';
      case 'SERVER': return 'The server reported a problem. Please try again; if it keeps happening, contact the office.';
      default: return backendError || 'Something went wrong. Please try again.';
    }
  }

  // ---------- timed fetch ----------
  /**
   * POST JSON with a hard timeout. Resolves with the parsed JSON body (even
   * when it says ok:false - that is the BACKEND's answer, classified by the
   * caller via classifyBackend). Rejects with a NetError for transport-level
   * failures: TIMEOUT / NETWORK / HTTP / BAD_RESPONSE.
   */
  function postJson(url, body, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 60000;
    var fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) return Promise.reject(NetError('NETWORK', 'fetch is not available'));
    var AC = opts.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null);
    var ctrl = AC ? new AC() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, timeoutMs);

    // Without AbortController, race the timer so the caller still never hangs.
    var timeoutRace = new Promise(function (_, reject) {
      if (!ctrl) setTimeout(function () { reject(NetError('TIMEOUT', 'timed out after ' + timeoutMs + 'ms', { retryable: true })); }, timeoutMs);
    });

    var req = fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (resp) {
      clearTimeout(timer);
      var status = resp.status;
      return resp.text().then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) {
          // Non-JSON body: a Google/Cloudflare HTML error page. 5xx/429 are
          // worth a retry; a 200 that isn't JSON is a contract break.
          var transient = status >= 500 || status === 429;
          throw NetError(transient ? 'BAD_RESPONSE_TRANSIENT' : 'BAD_RESPONSE', 'non-JSON response (HTTP ' + status + ')', { status: status, retryable: transient });
        }
        if (status >= 500 || status === 429) {
          // The Worker answers JSON even on errors; honour the body but keep the transport fact.
          parsed.__httpStatus = status;
        }
        return parsed;
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'NetError') throw err;
      if (timedOut || (err && err.name === 'AbortError')) throw NetError('TIMEOUT', 'timed out after ' + timeoutMs + 'ms', { retryable: true });
      throw NetError('NETWORK', (err && err.message) || 'network error', { retryable: true });
    });
    return ctrl ? req : Promise.race([req, timeoutRace]);
  }

  // ---------- JSONP (read-only backend GETs) ----------
  function jsonp(baseUrl, params, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 30000;
    return new Promise(function (resolve, reject) {
      var cbName = 'cb_' + Math.random().toString(36).slice(2);
      var settled = false;
      var scriptEl = document.createElement('script');
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true; cleanup(); reject(NetError('TIMEOUT', 'timed out after ' + timeoutMs + 'ms', { retryable: true }));
      }, timeoutMs);
      var slow = opts.onSlow ? setTimeout(function () { if (!settled) opts.onSlow(); }, opts.slowMs || 8000) : null;
      function cleanup() {
        clearTimeout(timer); if (slow) clearTimeout(slow);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
      }
      window[cbName] = function (data) {
        if (settled) return;
        settled = true; cleanup(); resolve(data);
      };
      var qs = 'callback=' + encodeURIComponent(cbName);
      Object.keys(params || {}).forEach(function (k) { qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
      scriptEl.src = baseUrl + '?' + qs;
      scriptEl.onerror = function () {
        if (settled) return;
        settled = true; cleanup(); reject(NetError('NETWORK', 'script load failed', { retryable: true }));
      };
      document.body.appendChild(scriptEl);
    });
  }

  // ---------- bounded retry ----------
  /**
   * Runs `fn` (returns a Promise of a backend body or rejects with NetError).
   * Retries up to `retries` more times with exponential backoff (baseMs,
   * 2*baseMs, ...) ONLY while the failure is retryable: a transport
   * TIMEOUT/NETWORK/5xx, or a backend answer classified BUSY. Any other
   * outcome - success, a terminal token error, a validation error - is
   * returned/thrown immediately.
   *
   * Returns the backend body (which may still be {ok:false}); the caller
   * decides what that means. `onRetry(attempt, kind, delayMs)` lets the UI
   * say "Retrying...".
   */
  function withRetry(fn, opts) {
    opts = opts || {};
    var retries = opts.retries === undefined ? 2 : opts.retries;
    var baseMs = opts.baseMs === undefined ? 1000 : opts.baseMs;
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function attempt(n) {
      return fn(n).then(function (body) {
        if (body && body.ok === false) {
          var kind = classifyBackend(body);
          if ((kind === 'BUSY' || kind === 'BAD_RESPONSE_TRANSIENT') && n < retries) {
            var d = baseMs * Math.pow(2, n);
            if (opts.onRetry) opts.onRetry(n + 1, kind, d);
            return sleep(d).then(function () { return attempt(n + 1); });
          }
        }
        return body;
      }, function (err) {
        var kind = err && err.kind;
        if (isRetryableKind(kind) && n < retries) {
          var d = baseMs * Math.pow(2, n);
          if (opts.onRetry) opts.onRetry(n + 1, kind, d);
          return sleep(d).then(function () { return attempt(n + 1); });
        }
        throw err;
      });
    }
    return attempt(0);
  }

  /** Console-only technical detail (never shown to the user). */
  function logTech(context, err) {
    try { console.warn('[HMG] ' + context, err && err.kind ? err.kind : '', err && err.message ? err.message : err); } catch (e) { /* ignore */ }
  }

  return {
    NetError: NetError, postJson: postJson, jsonp: jsonp, withRetry: withRetry,
    classifyBackend: classifyBackend, userMessage: userMessage, isTerminalTokenKind: isTerminalTokenKind,
    isRetryableKind: isRetryableKind, logTech: logTech,
  };
}));
