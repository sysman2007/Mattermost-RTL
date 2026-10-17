const test = require('node:test');
const assert = require('node:assert/strict');
const { htmlSrcdoc } = require('../public/md-preview/frame.js');

const CSP = /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/;

test('CSP meta goes right after the doctype, so the document stays in standards mode', () => {
  const out = htmlSrcdoc('<!DOCTYPE html>\n<html><body>hi</body></html>');
  assert.match(out, /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"/i);
  assert.match(out, CSP);
});

test('a BOM before the doctype is kept and the CSP still comes after the doctype', () => {
  const out = htmlSrcdoc('﻿  <!doctype html><p>x</p>');
  assert.match(out, /^﻿ {2}<!doctype html><meta/);
});

test('without a doctype the CSP is placed first, so scripts are blocked from the top', () => {
  const out = htmlSrcdoc('<script>alert(1)</script><p>x</p>');
  assert.ok(out.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(out.endsWith('<script>alert(1)</script><p>x</p>'));
});

test('the policy never allows script execution', () => {
  const out = htmlSrcdoc('<!doctype html>');
  const content = /content="([^"]*)"/.exec(out)[1];
  assert.doesNotMatch(content, /script-src/);
  assert.match(content, /^default-src 'none'/);
});
