/* i18n.js — the app in ten languages. ES2015 only (no ?., no spread).

   The key is the English string itself. That is deliberate: a missing
   translation falls back to something a person can read rather than to a dotted
   identifier, the English build needs no dictionary at all, and a string added
   in a hurry still works everywhere before anyone has translated it.

   The cost is that changing an English wording silently drops that string back
   to English in the other nine. `test-units.js` reads every translated string
   out of the shipped source and fails when a language does not cover one, which
   turns that silence into a failing test. */
(function (w) {
  'use strict';

  var I = {};

  /* Native names, because a language list is the one place a viewer cannot be
     expected to read the language they are trying to leave. */
  I.LANGS = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'pt', name: 'Português' },
    { code: 'it', name: 'Italiano' },
    { code: 'ru', name: 'Русский' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' }
  ];


  /* Strings that reach the translator through a variable rather than as a
     literal at the call site, so
     nothing that reads the source can see them: day and month names, the
     option labels a settings row cycles through, the built-in group names, and
     the keyboard reference. They are listed here so the dictionaries can be
     checked against a complete set — test-units.js fails a language that is
     missing any of them.

     Adding a new one of these means adding it here too. That is the price of
     translating at paint time, and it is cheaper than the alternative, which
     is freezing every label at load time. */
  I.EXTRA = [
    /* dayLabel(), and the catch-up browser's own list */
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',

    /* the built-in groups and the search placeholders, by section */
    'All', 'All channels', 'All movies', 'All series', 'Favourites', 'Recently watched',
    'Search', 'Search channels', 'Search movies', 'Search series',

    /* what a settings row cycles through */
    'On', 'Off', 'Dark', 'Light', 'Provider order', 'Channel number',
    '6 hours', '1 day', '2 days', '7 days',
    'Fit (letterbox)', 'Fill (crop)', 'Stretch', '24-hour', '12-hour',
    '3s', '5s', '8s', 'Always', 'Auto', 'Small', 'Large',
    'HLS (m3u8)', 'MPEG-TS (ts)', 'hls.js', 'Browser native',
    '-3 hours', '-2 hours', '-1 hour', 'None', '+1 hour', '+2 hours', '+3 hours',

    /* every settings row's own label and sub-line: row() translates them */
    'Language', 'What the app is written in',
    'Theme', 'Start on', 'Which list the app opens with',
    'Arrows change channel', 'Up and down while watching fullscreen',
    'Sort channels', 'Provider order, or by channel number',
    'Alternating row colours', 'Shade every other channel in the list',
    'Programme guide', 'Download and show now/next',
    'Catch-up history', 'How far back the guide lists finished programmes',
    'Picture size', 'How the video fills the screen',
    'Clock', 'Resume last channel', 'Start the last channel in the panel on launch',
    'Info bar duration',
    'Stream format', 'Change this if channels will not start',
    'Buffer', 'Small zaps faster, large is steadier',
    'Reconnect automatically', 'Retry a dropped stream instead of giving up',
    'Guide time offset', 'Shift the guide if its times are wrong',
    'HLS engine', 'Desktop only; the TV always uses AVPlay',
    'Hide empty groups', 'Groups with no channels in them',

    /* the keyboard reference, desktop only */
    'Move around', 'Arrow keys', 'Play / select', 'Enter', 'Fullscreen',
    'Enter again on the channel playing', 'Full screen, anywhere',
    'P - whatever is playing, wherever the cursor is', 'Back', 'Esc',
    'Channel +/-', 'Page Up / Page Down', 'R', 'G', 'B', 'Y', 'I', 'E', 'H',
    'Reload the playlist', 'Schedule', 'I — and Enter there sets a reminder',
    'Channel menu', 'Right from the list', 'Catch-up browser', 'Menu',
    'Left from the groups rail', 'Rewind / forward', 'Left / Right in fullscreen',
    'Jump 5 minutes', 'J / L', 'Replay a programme',
    'Enter on one marked in the guide', 'Jump to a channel', '0 - 9', 'This list',

    /* said through a constant, because two places say the same thing */
    'This channel cannot be rewound — it has no catch-up',

    /* placeholders the parsers put in when a provider leaves a field empty */
    'Unnamed', 'Ungrouped', 'No title'
  ];
  var cur = 'en';
  var dict = {};

  I.has = function (code) {
    for (var i = 0; i < I.LANGS.length; i++) if (I.LANGS[i].code === code) return true;
    return false;
  };

  I.name = function (code) {
    for (var i = 0; i < I.LANGS.length; i++) if (I.LANGS[i].code === code) return I.LANGS[i].name;
    return code;
  };

  /* What the TV is set to, when nobody has chosen. navigator.language is
     "pt-BR" or "en-GB"; only the part before the dash is asked about. */
  I.detect = function () {
    var tags = [];
    try {
      if (w.navigator.languages && w.navigator.languages.length) {
        tags = [].slice.call(w.navigator.languages);
      } else if (w.navigator.language) {
        tags = [w.navigator.language];
      }
    } catch (e) {}
    for (var i = 0; i < tags.length; i++) {
      var code = String(tags[i] || '').toLowerCase().split('-')[0];
      if (I.has(code)) return code;
    }
    return 'en';
  };

  I.set = function (code) {
    if (!I.has(code)) code = 'en';
    cur = code;
    dict = (code !== 'en' && w.LANGS && w.LANGS[code]) || {};
    document.documentElement.setAttribute('lang', code);
    I.apply();
    return cur;
  };

  I.lang = function () { return cur; };

  /* Set to {n} with { n: 4 }. A parameter that is not supplied is left as it
     is rather than printed as "undefined": a half-built sentence is easier to
     spot in a screenshot than a plausible wrong one. */
  I.t = function (s, params) {
    var out = dict[s] || s;
    if (params) {
      out = out.replace(/\{(\w+)\}/g, function (m, k) {
        return (params[k] === undefined || params[k] === null) ? m : String(params[k]);
      });
    }
    return out;
  };

  /* The static half of the interface. Everything in index.html that a viewer
     reads carries data-i18n with its English text, so the markup stays legible
     and the translation is a lookup rather than a second copy of the layout. */
  I.apply = function (root) {
    var host = root || document;
    var els = host.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = I.t(key);
    }
    var phs = host.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phs.length; j++) {
      var p = phs[j].getAttribute('data-i18n-ph');
      if (p) phs[j].setAttribute('placeholder', I.t(p));
    }
  };

  w.I18N = I;
  w.T = I.t;
})(window);
