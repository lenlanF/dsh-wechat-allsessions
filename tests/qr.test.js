// The iLink API returns only a URL, so the settings page needs a locally
// rendered code. These tests pin the encoder's structure; scannability was
// verified independently by decoding rendered images with pyzbar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeQr, qrSvg } from '../lib/qr.js';

const LOGIN_URL = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=905ee1856ae591439db7f7483e294bdb&bot_type=3';

test('a login URL encodes to a legal QR module size', () => {
  const { size, modules } = encodeQr(LOGIN_URL);
  // A QR version n is 4n+17 modules wide.
  assert.equal((size - 17) % 4, 0, 'size must match a QR version');
  assert.ok(size >= 21 && size <= 57, 'size must stay within versions 1-10');
  assert.equal(modules.length, size);
  for (const row of modules) assert.equal(row.length, size);
});

test('finder patterns sit in three corners', () => {
  const { size, modules } = encodeQr(LOGIN_URL);
  const dark = (x, y) => modules[y][x];
  // Outer ring is dark, inner ring light, 3x3 core dark.
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    assert.equal(dark(ox, oy), true, 'finder corner must be dark');
    assert.equal(dark(ox + 1, oy + 1), false, 'finder inner ring must be light');
    assert.equal(dark(ox + 3, oy + 3), true, 'finder core must be dark');
  }
});

test('the timing pattern alternates along row and column 6', () => {
  const { size, modules } = encodeQr(LOGIN_URL);
  // The run between the finder patterns is timing; the cells at 7-8 next to each
  // finder carry format information and are not part of it.
  for (let i = 9; i < size - 9; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, 'row 6 must alternate at ' + i);
    assert.equal(modules[i][6], i % 2 === 0, 'column 6 must alternate at ' + i);
  }
});

test('the dark module is always set', () => {
  const { size, modules } = encodeQr(LOGIN_URL);
  assert.equal(modules[size - 8][8], true, 'the mandatory dark module must be set');
});

test('different payloads produce different codes', () => {
  const a = encodeQr('https://example.weixin.qq.com/a');
  const b = encodeQr('https://example.weixin.qq.com/b');
  assert.notDeepEqual(a.modules, b.modules);
});

test('the rendered SVG is a standalone white-backed image', () => {
  const svg = qrSvg(LOGIN_URL);
  assert.ok(svg.startsWith('<svg'), 'must be an SVG document');
  assert.ok(svg.endsWith('</svg>'), 'must be closed');
  assert.ok(svg.includes('fill="#ffffff"'), 'must carry a white background for scanning');
  assert.ok(svg.includes('shape-rendering="crispEdges"'), 'modules must not be antialiased');
});

test('an oversized payload is rejected rather than silently truncated', () => {
  assert.throws(() => encodeQr('x'.repeat(5000)), /too large/);
});
