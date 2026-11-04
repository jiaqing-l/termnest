'use strict';
// Pure logic for the notes screen: export formats and time-only reminders (no dates to pick).
(function (root, factory) { if (typeof module === 'object') module.exports = factory(); else root.NotesCore = factory(); })(typeof window === 'object' ? window : this, function () {
  var LATE_MS = 120000; // a reminder fired this long after its time counts as missed
  var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  function toTxt(md) {
    return String(md).replace(/^#{1,6}\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
      .replace(/^- \[x\]/gim, '[x]').replace(/^- \[ \]/gm, '[ ]').replace(/^- /gm, '• ');
  }
  function slug(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ghi-chu';
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function dayStamp(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  function fileName(note, ext, now) { return 'ghi-chu-' + dayStamp(now || new Date()) + '-' + slug(note.title || '') + '.' + (ext === 'txt' ? 'txt' : 'md'); }
  function exportBody(note, ext) { return ext === 'txt' ? toTxt(note.text) : String(note.text); }

  // The moment a reminder with time "HH:MM" next rings on the day of `from` (local time).
  function occurrenceOn(time, day) { var p = time.split(':'); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(p[0]), Number(p[1]), 0, 0); }
  function plusDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), 0, 0); }
  // First occurrence at or after the reminder was created (so "15:00" typed at 15:58 rings tomorrow).
  function firstOccurrence(rem) {
    var created = new Date(rem.createdAt), today = occurrenceOn(rem.time, created);
    return today.getTime() >= created.getTime() ? today : plusDays(today, 1);
  }
  // Latest occurrence that should already have rung by `now`, or null.
  function latestOccurrence(rem, now) {
    var first = firstOccurrence(rem);
    if (now.getTime() < first.getTime()) return null;
    if (!rem.daily) return first;
    var today = occurrenceOn(rem.time, now);
    return today.getTime() <= now.getTime() ? today : plusDays(today, -1);
  }
  // Reminders that must ring now: [{ rem, at, late }]. Snoozed ones wait for snoozeUntil.
  function due(reminders, now) {
    var out = [];
    reminders.forEach(function (rem) {
      if (!rem.on || !TIME.test(rem.time)) return;
      if (rem.snoozeUntil && now.getTime() < rem.snoozeUntil) return;
      if (rem.snoozeUntil && now.getTime() >= rem.snoozeUntil) { out.push({ rem: rem, at: new Date(rem.snoozeUntil), late: now.getTime() - rem.snoozeUntil > LATE_MS }); return; }
      var at = latestOccurrence(rem, now);
      if (!at || (rem.lastFired || 0) >= at.getTime()) return;
      out.push({ rem: rem, at: at, late: now.getTime() - at.getTime() > LATE_MS });
    });
    return out;
  }
  function markFired(rem, at, now) {
    rem.lastFired = Math.max(at.getTime(), rem.lastFired || 0); delete rem.snoozeUntil;
    if (!rem.daily) rem.on = false; // a one-time reminder is finished once it has rung
    rem.firedAt = now.getTime();
  }
  function snooze(rem, label, now) {
    var ms = { '10 phút': 600000, '1 giờ': 3600000 }[label];
    var until = ms ? now.getTime() + ms : (function () { var d = plusDays(now, now.getHours() < 8 ? 0 : 1); d.setHours(8, 0, 0, 0); return d.getTime(); })();
    rem.snoozeUntil = until; rem.on = true; return until;
  }
  // "Today" / "Tomorrow" / "Every day" caption for a reminder row.
  function whenText(rem, now) {
    if (rem.daily) return i18n('notescore.moi_ngay');
    var n = firstOccurrence(rem);
    if (!rem.on) return i18n('notescore.da_nhac');
    return dayStamp(n) === dayStamp(now) ? i18n('usageui.hom_nay') : i18n('notescore.ngay_mai');
  }
  function quiet(now, from, to) { // "22:00".."07:00" may wrap midnight
    var m = now.getHours() * 60 + now.getMinutes(), a = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)), b = Number(to.slice(0, 2)) * 60 + Number(to.slice(3));
    return a <= b ? m >= a && m < b : m >= a || m < b;
  }
  return { toTxt: toTxt, slug: slug, fileName: fileName, exportBody: exportBody, due: due, markFired: markFired, snooze: snooze, whenText: whenText, quiet: quiet, firstOccurrence: firstOccurrence, TIME: TIME, LATE_MS: LATE_MS };
});
