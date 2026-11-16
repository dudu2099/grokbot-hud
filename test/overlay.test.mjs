import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyExpression, colorToRgb, SCAN } from '../src/overlay.mjs';
import { panelMount, themedExpression } from '../src/panel.mjs';

const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const near = (actual, expected, tolerance = 1.5) =>
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);

test('colorToRgb reads the formats Chrome reports, converting each to sRGB first', () => {
  near(colorToRgb('rgb(252, 252, 252)'), [252, 252, 252]);
  near(colorToRgb('rgba(28, 28, 28, 0.06)'), [28, 28, 28]);
  near(colorToRgb('color(srgb 0.5 0.25 1 / 0.4)'), [127.5, 63.75, 255]);
  near(colorToRgb('oklch(1 0 0)'), [255, 255, 255]);
  near(colorToRgb('oklch(0 0 0)'), [0, 0, 0]);
  near(colorToRgb('oklab(0.627955 0.224863 0.125846)'), [255, 0, 0]);
  near(colorToRgb('oklch(0.627955 0.257683 29.2339)'), [255, 0, 0]);
  near(colorToRgb('lab(54.2905 80.8049 69.891)'), [255, 0, 0], 2);
  near(colorToRgb('lch(54.2905 106.8372 40.8526)'), [255, 0, 0], 2);
  near(colorToRgb('lab(100 0 0)'), [255, 255, 255], 2);
  near(colorToRgb('color(display-p3 1 1 1)'), [255, 255, 255]);
  near(colorToRgb('color(srgb-linear 0.214 0.214 0.214)'), [127.5, 127.5, 127.5], 1);
  assert.equal(colorToRgb('transparent'), null);
  assert.equal(colorToRgb('linear-gradient(red, blue)'), null);
});

test('a light panel written as oklch(0.97 0 0) reads as light, the way the overlay decides light or dark', () => {
  const value = luma(colorToRgb('oklch(0.97 0 0)'));
  assert.ok(value >= 128, `luma ${value}`);
  assert.ok(luma(colorToRgb('oklch(0.2 0 0)')) < 128);
  assert.ok(luma(colorToRgb('lab(97 0 0)')) >= 128);
});

test('the page expression carries colorToRgb, so the page can read oklch() too', () => {
  const expression = applyExpression({ dataUrl: 'data:,', opacity: 1, appearance: 'light', token: 't', strength: null });
  assert.match(expression, /function colorToRgb\(color\)/);
  assert.equal(new Function(`return ${expression.slice(expression.lastIndexOf(', function colorToRgb') + 2, -1)}`)()('oklch(0.97 0 0)').length, 3);
});

test('scans are paced by named quiet and max-wait times', () => {
  assert.equal(typeof SCAN.quietMs, 'number');
  assert.equal(typeof SCAN.maxWaitMs, 'number');
  assert.ok(SCAN.quietMs < SCAN.maxWaitMs);
});

test('the panel host, its card and its round button all opt out of a window drag region', () => {
  const source = String(panelMount);
  assert.match(source, /-webkit-app-region:no-drag !important;/, 'host inline style');
  assert.match(source, /\[data-part="card"\], \[data-part="fab"\] \{ -webkit-app-region: no-drag; \}/, 'card and fab');
  assert.match(themedExpression({ dataUrl: 'data:,', opacity: 1, appearance: 'dark', token: 't', strength: null }, { themes: [], current: null, binding: 'b', state: null, strength: null, uploadLimit: 1 }), /no-drag/);
});
