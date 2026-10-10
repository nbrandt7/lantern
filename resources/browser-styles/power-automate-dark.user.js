// ==UserScript==
// @name        Lantern Power Automate Dark Mode
// @namespace   lantern
// @version     1.0.0
// @description Darken the Power Automate cloud flow designer in VS Code's Integrated Browser.
// @match       https://make.powerautomate.com/*
// @match       https://*.make.powerautomate.com/*
// @match       https://webshell.suite.office.com/iframe/*
// @run-at      document-start
// @grant       GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  GM_addStyle(`
    /* Invert white surfaces while hue rotation keeps brand colors close. */
    html {
      background: #fff !important;
      filter: invert(1) hue-rotate(180deg) !important;
    }

    /* Keep media, icons, and embedded frames in their original colors. */
    html img,
    html video,
    html canvas,
    html svg,
    html iframe {
      filter: invert(1) hue-rotate(180deg) !important;
    }
  `);
})();
