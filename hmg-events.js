/* HMG event alias matching (V1.5, 2026-11-17) - shared by supervisor.js and control.js, unit-tested in Node.
 * The catalog times are a REFERENCE for the supervisor: nothing here ever fills a punch on its own.
 * HMGEvents.normalize(s)            -> comparable text (Arabic letters unified, tashkeel removed, case / spacing / punctuation folded,
 *                                      blvd -> boulevard, a leading "al" detached, doubled letters collapsed)
 * HMGEvents.suggest(rec, catalog)   -> { candidates: [{event, score, why}], best: event|null, ambiguous: bool }
 *   rec = {zone, event, workDate}; catalog = svEventCatalog response ({events:[{eventId, zone, name, dateFrom, dateTo, status, aliases:[{alias,status}], shifts:[..]}]})
 * HMGEvents.shiftWindow(workDate, shift) -> {startAt, endAt, crossesMidnight} ("yyyy-mm-dd HH:mm"; end on the next day when end <= start)
 */
(function (root) {
  'use strict';
  var ABBR = { blvd: 'boulevard', bvd: 'boulevard', st: 'street', intl: 'international', bball: 'basketball' };
  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function normalize(s) {
    var t = str(s).toLowerCase();
    t = t.replace(/[ً-ٰٟـ]/g, '')            // tashkeel + tatweel
      .replace(/[آأإٱ]/g, 'ا')            // alef forms -> ا
      .replace(/ة/g, 'ه').replace(/ى/g, 'ي')   // ة -> ه, ى -> ي
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
    t = t.replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
    var toks = t.split(/\s+/).filter(Boolean).map(function (w) {
      w = ABBR[w] || w;
      if (/^al[a-z]{3,}$/.test(w)) w = w.slice(2);                // alzallal -> zallal ; "al" alone is dropped below
      if (/^ال.{3,}$/.test(w)) w = w.slice(2);           // الزلال -> زلال
      return w.replace(/([a-z])\1+/g, '$1');                      // dirrah -> dirah
    }).filter(function (w) { return w !== 'al' && w !== 'the' && w !== 'ال'; });
    return toks.join(' ');
  }
  function compact(s) { return normalize(s).replace(/\s+/g, ''); }
  function tokens(s) { var n = normalize(s); return n ? n.split(' ') : []; }
  function inDates(ev, dk) {
    if (!dk) return true;
    if (ev.dateFrom && dk < ev.dateFrom) return false;
    if (ev.dateTo && dk > ev.dateTo) return false;
    return true;
  }
  function zoneEq(a, b) { return compact(a) === compact(b); }
  /** one name vs one candidate string -> 0..100 */
  function nameScore(a, b) {
    var ca = compact(a), cb = compact(b);
    if (!ca || !cb) return 0;
    if (ca === cb) return 100;
    var short = ca.length < cb.length ? ca : cb, long = ca.length < cb.length ? cb : ca;
    if (short.length >= 4 && long.indexOf(short) !== -1) return 85;
    var ta = tokens(a), tb = tokens(b), inter = 0, seen = {};
    tb.forEach(function (w) { seen[w] = 1; });
    ta.forEach(function (w) { if (seen[w]) inter++; });
    var uni = ta.length + tb.length - inter;
    return uni ? Math.round(70 * inter / uni) : 0;
  }
  function suggest(rec, catalog) {
    var evs = (catalog && catalog.events) || [], out = [];
    evs.forEach(function (ev) {
      if (str(ev.status).toUpperCase() === 'ARCHIVED') return;
      if (!inDates(ev, rec.workDate)) return;
      var names = [ev.name].concat((ev.aliases || []).filter(function (a) { return str(a.status || 'ACTIVE').toUpperCase() === 'ACTIVE'; }).map(function (a) { return a.alias; }));
      var best = 0, why = '';
      names.forEach(function (n) { var s = nameScore(rec.event, n); if (s > best) { best = s; why = n === ev.name ? 'name' : 'alias "' + n + '"'; } });
      if (!best) return;
      var zoneOk = !ev.zone || !rec.zone || zoneEq(ev.zone, rec.zone);
      if (!zoneOk) { best -= 30; why += ', other zone'; }
      else if (ev.zone && rec.zone) { best += 5; why += ', same zone'; }
      if (ev.dateFrom || ev.dateTo) { best += 3; why += ', dated'; }
      if (best >= 50) out.push({ event: ev, score: Math.min(best, 108), why: why });
    });
    out.sort(function (x, y) { return y.score - x.score || (x.event.name < y.event.name ? -1 : 1); });
    var top = out[0], second = out[1];
    var confident = !!(top && top.score >= 85 && (!second || second.score < top.score - 10));
    return { candidates: out.slice(0, 8), best: confident ? top.event : null, ambiguous: !!(top && !confident) };
  }
  function addDay(dk, n) { var d = new Date(dk + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function shiftWindow(workDate, sh) {
    if (!sh || !/^\d{2}:\d{2}$/.test(str(sh.start))) return null;
    var hasEnd = /^\d{2}:\d{2}$/.test(str(sh.end));
    var cross = hasEnd && str(sh.end) <= str(sh.start);
    return { startAt: workDate + ' ' + sh.start, endAt: hasEnd ? (cross ? addDay(workDate, 1) : workDate) + ' ' + sh.end : '', crossesMidnight: cross,
      durationMin: hasEnd ? ((+sh.end.slice(0, 2)) * 60 + (+sh.end.slice(3)) - ((+sh.start.slice(0, 2)) * 60 + (+sh.start.slice(3))) + (cross ? 1440 : 0)) : null };
  }
  var api = { normalize: normalize, compact: compact, nameScore: nameScore, suggest: suggest, shiftWindow: shiftWindow, inDates: inDates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HMGEvents = api;
})(typeof window !== 'undefined' ? window : this);
