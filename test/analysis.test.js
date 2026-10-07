import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePrices,
  analyzeIntraday,
  normalizeSymbol
} from '../src/analysis.js';

test('normalizes a ticker and rejects unsafe input', () => {
  assert.equal(normalizeSymbol('  AAPL.US  '), 'aapl.us');
  assert.equal(normalizeSymbol('005930.KR'), '005930.kr');
  assert.throws(() => normalizeSymbol(''), /종목 코드/);
  assert.throws(() => normalizeSymbol('AAPL/SECRET'), /형식/);
});

test('calculates period returns, averages, volatility, and drawdown', () => {
  const rows = Array.from({ length: 70 }, (_, index) => ({
    date: `2024-01-${String(index + 1).padStart(2, '0')}`,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1000
  }));

  const result = analyzePrices(rows);

  assert.equal(result.latest.close, 169);
  assert.equal(result.previous.close, 168);
  assert.ok(Math.abs(result.periods.oneMonth - 14.18918918918919) < 1e-10);
  assert.ok(Math.abs(result.periods.threeMonth - 59.43396226415094) < 1e-10);
  assert.equal(result.movingAverages.ma20, 159.5);
  assert.equal(result.movingAverages.ma50, 144.5);
  assert.equal(result.maxDrawdown, 0);
  assert.match(result.trend, /상승/);
  assert.ok(result.volatilityAnnualized > 0);
});

test('requires at least two price rows', () => {
  assert.throws(() => analyzePrices([{ date: '2024-01-01', close: 100 }]), /두 개/);
});

test('calculates live intraday metrics from minute candles', () => {
  const rows = [
    { date: '2026-10-07T09:00:00+09:00', open: 100, high: 101, low: 99, close: 100, volume: 100 },
    { date: '2026-10-07T09:01:00+09:00', open: 100, high: 103, low: 100, close: 102, volume: 200 },
    { date: '2026-10-07T09:02:00+09:00', open: 102, high: 103, low: 100, close: 101, volume: 300 }
  ];

  const result = analyzeIntraday(rows, { sessionOpen: 98 });

  assert.equal(result.latest.close, 101);
  assert.ok(Math.abs(result.oneBarReturn - ((101 / 102 - 1) * 100)) < 1e-10);
  assert.ok(Math.abs(result.windowReturn - 1) < 1e-10);
  assert.ok(Math.abs(result.sessionReturn - ((101 / 98 - 1) * 100)) < 1e-10);
  assert.equal(result.movingAverages.ma20, 101);
  assert.equal(result.movingAverages.ma50, 101);
  assert.ok(result.vwap > 100 && result.vwap < 102);
  assert.ok(result.volatility > 0);
  assert.ok(result.maxDrawdown < 0);
});
