import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, merge, trim, DAY, type Point } from '../src/history.ts';
import { scansSince } from '../src/savedVars.ts';

const NOW = 1762400000;

test('decode and encode round trip', () => {
  const packed = '1:2:3:4,5:6:7:8';
  assert.deepEqual(decode(packed), [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.equal(encode(decode(packed)), packed);
  assert.deepEqual(decode(''), []);
  assert.deepEqual(decode('1:2:x:4,5:6:7:8'), [[5, 6, 7, 8]]);
});

test('merge sorts, dedupes nearby points, and prefers the first list', () => {
  const mine: Point[] = [[1000, 10, 10, 1], [5000, 50, 50, 1]];
  const server: Point[] = [[1600, 99, 99, 1], [3000, 30, 30, 1], [5100, 98, 98, 1]];
  assert.deepEqual(merge([mine, server]), [[1000, 10, 10, 1], [3000, 30, 30, 1], [5000, 50, 50, 1]]);
  // the trusted point replaces a less trusted one that came first
  assert.deepEqual(merge([[[1600, 1, 1, 1]], [[1000, 9, 9, 9]]]), [[1600, 1, 1, 1]]);
});

test('trim keeps recent points and merges older ones per day', () => {
  const dayStart = Math.floor((NOW - 10 * DAY) / DAY) * DAY;
  const points: Point[] = [
    [NOW - 40 * DAY, 1, 1, 1],          // too old
    [dayStart + 100, 100, 100, 10],     // same day: merged
    [dayStart + 200, 80, 200, 30],
    [NOW - 3600, 500, 500, 5],          // recent: kept
  ];
  const out = trim(points, NOW, { days: 30, rawDays: 3 });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].slice(1), [80, 150, 20]);
  assert.deepEqual(out[1], [NOW - 3600, 500, 500, 5]);
});

test('scansSince groups points by scan time', () => {
  const realm: { items: Record<string, Point[]> } = { items: { 1: [[100, 1, 1, 1], [200, 2, 2, 2]], 2: [[200, 3, 3, 3]] } };
  assert.deepEqual(scansSince(realm, 100), [{ t: 200, items: [[1, 2, 2, 2], [2, 3, 3, 3]] }]);
  assert.equal(scansSince(realm, 0).length, 2);
});
