import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateHistory,
  intradayMinutes,
  isIntradayMode
} from '../public/chart-utils.js';

const intradayHistory = [
  { date: '2026-10-07T00:00:00+09:00', open: 99, high: 101, low: 98, close: 100, volume: 10 },
  { date: '2026-10-07T00:01:00+09:00', open: 100, high: 102, low: 99, close: 101, volume: 20 },
  { date: '2026-10-07T00:02:00+09:00', open: 101, high: 103, low: 100, close: 102, volume: 30 },
  { date: '2026-10-07T00:03:00+09:00', open: 102, high: 104, low: 101, close: 103, volume: 40 },
  { date: '2026-10-07T00:04:00+09:00', open: 103, high: 105, low: 102, close: 104, volume: 50 },
  { date: '2026-10-07T00:05:00+09:00', open: 104, high: 106, low: 103, close: 105, volume: 60 }
];

test('aggregates one-minute candles into selectable intraday intervals', () => {
  const candles = aggregateHistory(intradayHistory, '3m');

  assert.equal(candles.length, 2);
  assert.equal(candles[0].close, 102);
  assert.equal(candles[1].close, 105);
  assert.equal(candles[0].open, 99);
  assert.equal(candles[0].high, 103);
  assert.equal(candles[0].low, 98);
  assert.equal(candles[0].volume, 60);
  assert.equal(intradayMinutes('1m'), 1);
  assert.equal(intradayMinutes('30m'), 30);
  assert.equal(isIntradayMode('10m'), true);
  assert.equal(isIntradayMode('month'), false);
});

test('keeps the last close when aggregating weekly and monthly chart modes', () => {
  const history = [
    { date: '2026-01-30', close: 100 },
    { date: '2026-02-02', close: 110 },
    { date: '2026-02-27', close: 120 },
    { date: '2026-03-02', close: 130 }
  ];

  assert.deepEqual(aggregateHistory(history, 'month').map((point) => point.close), [100, 120, 130]);
  assert.deepEqual(aggregateHistory(history, 'day').map((point) => point.close), [100, 110, 120, 130]);
});
