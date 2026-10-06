#!/usr/bin/env node
/**
 * Unit tests for net.js (timeouts, classification, bounded retry).
 * No dependencies; Node 18+.   Usage: node tools/net-test.js
 */
'use strict';
var path = require('path');
var Net = require(path.join(__dirname, '..', 'net.js'));

var failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function fakeResp(status, text) { return { status: status, text: function () { return Promise.resolve(text); } }; }
var noSleep = function () { return Promise.resolve(); };

async function main() {
  // ---------- classification ----------
  var cases = [
    [{ ok: false, code: 'INVALID_TOKEN', error: 'Invalid link.' }, 'TOKEN_INVALID'],
    [{ ok: false, code: 'EXPIRED', error: 'This link has expired.' }, 'TOKEN_EXPIRED'],
    [{ ok: false, code: 'REVOKED', error: 'x' }, 'TOKEN_REVOKED'],
    [{ ok: false, code: 'MISSING_TOKEN' }, 'TOKEN_MISSING'],
    [{ ok: false, error: 'Invalid link.' }, 'TOKEN_INVALID'],                 // older backend: exact message
    [{ ok: false, error: 'This link has expired.' }, 'TOKEN_EXPIRED'],
    [{ ok: false, error: 'This link has been revoked.' }, 'TOKEN_REVOKED'],
    [{ ok: false, error: 'Missing/invalid token' }, 'TOKEN_MISSING'],         // Worker's own pre-check
    [{ ok: false, error: 'System is busy processing another request for this assignment. Please retry in a moment.', retryable: true }, 'BUSY'],
    [{ ok: false, code: 'PENDING_REMAINING', error: '3 record(s) are still pending' }, 'PENDING_REMAINING'],
    [{ ok: false, code: 'COMPLETED', error: 'done' }, 'ALREADY_SUBMITTED'],
    [{ ok: false, error: 'something odd' }, 'BACKEND'],
  ];
  cases.forEach(function (c) { check('classify ' + JSON.stringify(c[0]).slice(0, 70) + ' -> ' + c[1], Net.classifyBackend(c[0]) === c[1], Net.classifyBackend(c[0])); });
  ['TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_MISSING'].forEach(function (k) {
    check(k + ' is a terminal token kind and NOT retryable', Net.isTerminalTokenKind(k) && !Net.isRetryableKind(k));
  });
  ['TIMEOUT', 'NETWORK', 'BUSY', 'HTTP_5XX'].forEach(function (k) { check(k + ' is retryable', Net.isRetryableKind(k)); });
  check('user messages never contain URLs or tokens', ['TIMEOUT', 'NETWORK', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SERVER'].every(function (k) { return !/https?:|token=|workers\.dev|script\.google/.test(Net.userMessage(k)); }));

  // ---------- postJson: timeout never hangs ----------
  var t0 = Date.now();
  var hangFetch = function (url, o) { return new Promise(function (_, reject) { o.signal.addEventListener('abort', function () { var e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); }); };
  try { await Net.postJson('http://x', {}, { timeoutMs: 120, fetch: hangFetch }); check('hanging request rejects', false); }
  catch (e) { check('hanging request rejects as TIMEOUT within the limit (never loads forever)', e.kind === 'TIMEOUT' && e.retryable && Date.now() - t0 < 1500, { kind: e.kind, ms: Date.now() - t0 }); }

  try { await Net.postJson('http://x', {}, { timeoutMs: 1000, fetch: function () { return Promise.reject(new TypeError('Failed to fetch')); } }); check('network failure rejects', false); }
  catch (e) { check('fetch rejection -> NETWORK (retryable)', e.kind === 'NETWORK' && e.retryable); }

  try { await Net.postJson('http://x', {}, { timeoutMs: 1000, fetch: function () { return Promise.resolve(fakeResp(502, '<html>Bad gateway</html>')); } }); check('html 502 rejects', false); }
  catch (e) { check('HTML 502 body -> BAD_RESPONSE_TRANSIENT (retryable)', e.kind === 'BAD_RESPONSE_TRANSIENT' && e.retryable); }

  try { await Net.postJson('http://x', {}, { timeoutMs: 1000, fetch: function () { return Promise.resolve(fakeResp(200, '<html>login</html>')); } }); check('html 200 rejects', false); }
  catch (e) { check('HTML 200 body -> BAD_RESPONSE (contract break, NOT retryable)', e.kind === 'BAD_RESPONSE' && !e.retryable); }

  var okBody = await Net.postJson('http://x', { a: 1 }, { timeoutMs: 1000, fetch: function (u, o) { return Promise.resolve(fakeResp(200, JSON.stringify({ ok: true, echo: JSON.parse(o.body) }))); } });
  check('valid JSON resolves and body is sent as JSON', okBody.ok && okBody.echo.a === 1);

  var bk = await Net.postJson('http://x', {}, { timeoutMs: 1000, fetch: function () { return Promise.resolve(fakeResp(200, JSON.stringify({ ok: false, code: 'EXPIRED' }))); } });
  check('backend ok:false is returned (not thrown) for the caller to classify', bk.ok === false && Net.classifyBackend(bk) === 'TOKEN_EXPIRED');

  // ---------- withRetry ----------
  var calls = 0;
  var r1 = await Net.withRetry(function () { calls++; return calls < 3 ? Promise.reject(Net.NetError('TIMEOUT', 't', { retryable: true })) : Promise.resolve({ ok: true }); }, { retries: 2, baseMs: 1, sleep: noSleep });
  check('retries transient failures then succeeds (3 calls)', r1.ok && calls === 3, calls);

  calls = 0;
  try { await Net.withRetry(function () { calls++; return Promise.reject(Net.NetError('NETWORK', 'n', { retryable: true })); }, { retries: 2, baseMs: 1, sleep: noSleep }); check('exhausts', false); }
  catch (e) { check('retry is BOUNDED: gives up after 1 + 2 retries, then fails clearly', e.kind === 'NETWORK' && calls === 3, calls); }

  calls = 0;
  var term = await Net.withRetry(function () { calls++; return Promise.resolve({ ok: false, code: 'REVOKED', error: 'This link has been revoked.' }); }, { retries: 3, baseMs: 1, sleep: noSleep });
  check('terminal token error (revoked) is NEVER retried', calls === 1 && term.ok === false, calls);

  calls = 0;
  await Net.withRetry(function () { calls++; return Promise.resolve({ ok: false, code: 'EXPIRED' }); }, { retries: 3, baseMs: 1, sleep: noSleep });
  check('expired token is NEVER retried', calls === 1, calls);

  calls = 0;
  var busy = await Net.withRetry(function () { calls++; return Promise.resolve(calls < 2 ? { ok: false, retryable: true, error: 'busy' } : { ok: true }); }, { retries: 2, baseMs: 1, sleep: noSleep });
  check('backend "busy" (retryable:true) is retried and then succeeds', busy.ok && calls === 2, calls);

  calls = 0;
  var delays = [];
  try { await Net.withRetry(function () { calls++; return Promise.reject(Net.NetError('TIMEOUT', 't', { retryable: true })); }, { retries: 3, baseMs: 100, sleep: function (ms) { delays.push(ms); return Promise.resolve(); } }); } catch (e) { /* expected */ }
  check('backoff is exponential (100, 200, 400)', JSON.stringify(delays) === '[100,200,400]', delays);

  calls = 0;
  try { await Net.withRetry(function () { calls++; return Promise.reject(Net.NetError('BAD_RESPONSE', 'x')); }, { retries: 3, baseMs: 1, sleep: noSleep }); } catch (e) { /* expected */ }
  check('non-retryable transport error (contract break) is not retried', calls === 1, calls);

  console.log('\n' + (failures === 0 ? 'ALL NET.JS CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(function (e) { console.error(e); process.exit(2); });
