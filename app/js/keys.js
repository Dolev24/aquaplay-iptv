/* keys.js — Samsung remote + desktop keyboard, mapped to one action vocabulary.

   Actions: up down left right ok back exit
            chanUp chanDown playPause stop rew ff
            red green yellow blue info guide
            digit (with .digit), char (with .key) */
(function (w) {
  'use strict';

  var K = {};

  var MAP = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    13: 'ok',
    10009: 'back',      // Tizen RETURN
    8: 'back',          // Backspace (desktop)
    27: 'back',         // Esc (desktop)
    10182: 'exit',      // Tizen EXIT
    427: 'chanUp',   33: 'chanUp',     // PageUp
    428: 'chanDown', 34: 'chanDown',   // PageDown
    415: 'play', 19: 'pause', 10252: 'playPause', 413: 'stop',
    412: 'rew', 417: 'ff',
    403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
    457: 'info', 458: 'guide',
    36: 'home', 35: 'end'
  };

  /* Desktop-only shortcuts so the app is testable without a remote. */
  var CHAR_MAP = { r: 'red', g: 'green', y: 'yellow', b: 'blue', i: 'info', e: 'guide',
                   h: 'help', j: 'rew', l: 'ff', p: 'play' };

  var handler = null;
  K.setHandler = function (fn) { handler = fn; };

  var TIZEN_KEYS = [
    'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    'ChannelUp', 'ChannelDown',
    'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
    'MediaRewind', 'MediaFastForward',
    'Info', 'Guide',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
  ];

  K.init = function () {
    if (U.isTizen) {
      for (var i = 0; i < TIZEN_KEYS.length; i++) {
        try { w.tizen.tvinputdevice.registerKey(TIZEN_KEYS[i]); }
        catch (e) { U.log('registerKey failed', TIZEN_KEYS[i]); }
      }
    }
    document.addEventListener('keydown', onKey, false);
  };

  K.exitApp = function () {
    if (U.isTizen) {
      try { w.tizen.application.getCurrentApplication().exit(); return; } catch (e) {}
    }
    U.toast('Exit');
  };

  function typingInInput() {
    var a = document.activeElement;
    return !!(a && a.tagName === 'INPUT');
  }

  function onKey(ev) {
    var code = ev.keyCode;
    var action = MAP[code];

    // Digits 0-9
    if (!action && code >= 48 && code <= 57 && !typingInInput()) {
      dispatch({ action: 'digit', digit: code - 48, ev: ev });
      return;
    }
    if (!action && code >= 96 && code <= 105 && !typingInInput()) {
      dispatch({ action: 'digit', digit: code - 96, ev: ev });
      return;
    }

    // Desktop letter shortcuts (never while typing)
    if (!action && !U.isTizen && !typingInInput()) {
      var ch = String.fromCharCode(code).toLowerCase();
      if (CHAR_MAP[ch]) { dispatch({ action: CHAR_MAP[ch], ev: ev }); return; }
    }

    if (!action) return;

    // While an on-screen keyboard / text field has focus, left-right and
    // backspace belong to the field, not to us.
    if (typingInInput()) {
      if (action === 'left' || action === 'right') return;
      if (code === 8) return;  // backspace deletes a character
    }

    dispatch({ action: action, ev: ev });
  }

  function dispatch(e) {
    if (e.ev) { e.ev.preventDefault(); e.ev.stopPropagation(); }
    // Any key dismisses the keyboard reference.
    if (U.helpOpen) { U.helpClose(); return; }
    if (e.action === 'help') { if (!U.isTizen) U.help(); return; }
    if (U.confirmOpen) { U.confirmKey(e.action); return; }
    if (U.numberOpen) { U.numberKey(e); return; }
    if (handler) handler(e);
  }

  w.Keys = K;
})(window);
