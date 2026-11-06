#!/usr/bin/env node
/**
 * Offline static checks for the HMG frontend (no network, no data, safe for public CI).
 *  1. every page's local <script src> / <link href> file exists;
 *  2. control.html loads every local script / style with ONE shared ?v= cache-busting tag
 *     (a script changed without bumping the tag keeps serving the cached old file for ~10 min);
 *  3. every *.js file parses (node --check equivalent via the VM compiler);
 *  4. no obvious secret material is committed (bridge secret assignments, Apps Script admin tokens in URLs).
 * Usage: node tools/static-check.js   (exit code 1 on any failure)
 */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = path.join(__dirname, '..');
var failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

var pages = fs.readdirSync(ROOT).filter(function (f) { return /\.html$/.test(f); });
pages.forEach(function (page) {
  var html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  var refs = [];
  html.replace(/<script[^>]+src="([^"]+)"/g, function (m, u) { refs.push(u); return m; });
  html.replace(/<link[^>]+href="([^"]+)"/g, function (m, u) { refs.push(u); return m; });
  var local = refs.filter(function (u) { return !/^(https?:)?\/\//.test(u) && !/^data:/.test(u); });
  local.forEach(function (u) {
    var file = u.split('?')[0].split('#')[0];
    check(page + ' references existing file ' + file, fs.existsSync(path.join(ROOT, file)));
  });
  if (page === 'control.html') {
    var tags = {};
    local.forEach(function (u) { var m = /\?v=([^&#]+)/.exec(u); tags[m ? m[1] : '(none)'] = true; });
    var list = Object.keys(tags);
    check('control.html uses one shared ?v= tag on every local script/style', list.length === 1 && list[0] !== '(none)', list.join(', '));
  }
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce(function (out, d) {
    if (d.name === '.git' || d.name === 'node_modules') return out;
    var p = path.join(dir, d.name);
    return d.isDirectory() ? out.concat(walk(p)) : out.concat([p]);
  }, []);
}
var files = walk(ROOT);
files.filter(function (f) { return /\.js$/.test(f); }).forEach(function (f) {
  var rel = path.relative(ROOT, f), src = fs.readFileSync(f, 'utf8').replace(/^#!.*/, '');
  try { new vm.Script(src, { filename: rel }); check('parses: ' + rel, true); }
  catch (e) { check('parses: ' + rel, false, e.message); }
});

var secretPatterns = [
  { name: 'bridge secret assignment', re: /HMG_BRIDGE_SECRET\s*[:=]\s*['"][^'"]{8,}['"]/ },
  { name: 'admin token inside a URL', re: /adminToken=[A-Za-z0-9]{24,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
files.filter(function (f) { return /\.(js|html|css|json|md)$/.test(f); }).forEach(function (f) {
  var rel = path.relative(ROOT, f), src = fs.readFileSync(f, 'utf8');
  secretPatterns.forEach(function (p) { check('no ' + p.name + ' in ' + rel, !p.re.test(src)); });
});

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL STATIC CHECKS PASSED');
process.exit(failures ? 1 : 0);
