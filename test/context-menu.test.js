'use strict';
// Unit tests for the pure parts of webapp/dist/main.js. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = { registerPlugin() {} };
// Minimal browser stand-ins for main.js's load-time code.
global.document = { documentElement: {} };
global.MutationObserver = class { observe() {} disconnect() {} };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.HTMLTextAreaElement = class { set value(v) {} };
const { placeMenu } = require('../webapp/dist/main.js');

const VW = 1000, VH = 800, W = 264, H = 400;

test('LTR: opens to the right of and below the cursor', () => {
  assert.deepEqual(placeMenu(100, 100, W, H, VW, VH, false), { left: 100, top: 100 });
});

test('RTL: opens to the left of the cursor', () => {
  assert.deepEqual(placeMenu(500, 100, W, H, VW, VH, true), { left: 236, top: 100 });
});

test('LTR near the right edge flips to the left', () => {
  assert.deepEqual(placeMenu(900, 100, W, H, VW, VH, false), { left: 636, top: 100 });
});

test('RTL near the left edge flips to the right', () => {
  assert.deepEqual(placeMenu(50, 100, W, H, VW, VH, true), { left: 50, top: 100 });
});

test('near the bottom opens upward', () => {
  assert.deepEqual(placeMenu(100, 700, W, H, VW, VH, false), { left: 100, top: 300 });
});

test('menu taller than the space above and below stays inside the viewport', () => {
  const p = placeMenu(100, 300, W, 790, VW, VH, false);
  assert.ok(p.top >= 4 && p.top + 790 <= VH, JSON.stringify(p));
});

test('viewport narrower than the menu clamps to the margin', () => {
  assert.equal(placeMenu(100, 100, W, H, 200, VH, false).left, 4);
});
