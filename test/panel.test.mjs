import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePanelPayload, UPLOAD } from '../src/panel.mjs';

const payload = (value) => JSON.stringify(value);

test('the three panel messages parse into their tagged shapes and extra fields are dropped', () => {
  assert.deepEqual(parsePanelPayload(payload({ type: 'apply', themeId: 'paper-light', extra: 1 })), { type: 'apply', themeId: 'paper-light' });
  assert.deepEqual(parsePanelPayload(payload({ type: 'restore', themeId: 'x' })), { type: 'restore' });
  assert.deepEqual(parsePanelPayload(payload({ type: 'panel', x: 40, y: 12.5, collapsed: true, z: 9 })), {
    type: 'panel',
    x: 40,
    y: 12.5,
    collapsed: true,
  });
});

test('strength and upload messages parse, keeping only their own fields', () => {
  assert.deepEqual(parsePanelPayload(payload({ type: 'strength', value: 0, x: 1 })), { type: 'strength', value: 0 });
  assert.deepEqual(parsePanelPayload(payload({ type: 'strength', value: 100 })), { type: 'strength', value: 100 });
  const data = Buffer.from('any bytes at all').toString('base64');
  assert.deepEqual(parsePanelPayload(payload({ type: 'upload', name: 'me.png', data, path: 'C:\\x' })), { type: 'upload', name: 'me.png', data });
  const nearLimit = 'A'.repeat(UPLOAD.maxData - (UPLOAD.maxData % 4));
  assert.equal(parsePanelPayload(payload({ type: 'upload', name: 'big.png', data: nearLimit }))?.data.length, nearLimit.length);
});

test('bad strength and upload messages are dropped', () => {
  const dropped = [
    payload({ type: 'strength' }),
    payload({ type: 'strength', value: -1 }),
    payload({ type: 'strength', value: 101 }),
    payload({ type: 'strength', value: 50.5 }),
    payload({ type: 'strength', value: '50' }),
    payload({ type: 'strength', value: null }),
    payload({ type: 'upload', name: 'me.png' }),
    payload({ type: 'upload', data: 'AAAA' }),
    payload({ type: 'upload', name: '', data: 'AAAA' }),
    payload({ type: 'upload', name: 'x'.repeat(256), data: 'AAAA' }),
    payload({ type: 'upload', name: 7, data: 'AAAA' }),
    payload({ type: 'upload', name: 'me.png', data: '' }),
    payload({ type: 'upload', name: 'me.png', data: 'AAA' }),
    payload({ type: 'upload', name: 'me.png', data: 'AA!=' }),
    payload({ type: 'upload', name: 'me.png', data: ['AAAA'] }),
    payload({ type: 'upload', name: 'me.png', data: 'A'.repeat(UPLOAD.maxData + 4) }),
    payload({ type: 'upload-begin', name: 'me.png' }),
  ];
  for (const text of dropped) assert.equal(parsePanelPayload(text), null, text.slice(0, 80));
});

test('unknown tags, malformed fields and non-JSON payloads are dropped', () => {
  const dropped = [
    payload({ type: 'quit' }),
    payload({ type: 'upload', path: 'C:\\me.png' }),
    payload({ type: '__proto__' }),
    payload({ type: 'toString' }),
    payload({ themeId: 'paper-light' }),
    payload({ type: 'apply' }),
    payload({ type: 'apply', themeId: '../etc' }),
    payload({ type: 'apply', themeId: 7 }),
    payload({ type: 'panel', x: '10', y: 0, collapsed: false }),
    payload({ type: 'panel', x: 10, y: 0 }),
    payload('apply'),
    payload(null),
    payload([{ type: 'restore' }]),
    'not json',
    '',
  ];
  for (const text of dropped) assert.equal(parsePanelPayload(text), null, text);
});
