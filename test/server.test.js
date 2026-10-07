import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const rows = [
  { date: '2024-01-02', open: 100, high: 105, low: 99, close: 102, volume: 1000 },
  { date: '2024-01-03', open: 102, high: 106, low: 101, close: 104, volume: 1100 }
];

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('returns 400 for an invalid ticker before calling the provider', async () => {
  let providerCalled = false;
  const server = createServer({
    marketClient: {
      resolveSymbol: async () => {
        const error = new Error('종목 코드 형식이 올바르지 않습니다.');
        error.status = 400;
        throw error;
      },
      getDailyCandles: async () => {
        providerCalled = true;
        return rows;
      }
    },
    fetchImpl: async () => {
      providerCalled = true;
      return new Response();
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze?symbol=AAPL/SECRET`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /형식/);
    assert.equal(providerCalled, false);
  });
});

test('returns analyzed data for a valid provider response', async () => {
  const server = createServer({
    marketClient: {
      resolveSymbol: async (input) => {
        assert.equal(input, 'AAPL.US');
        return { symbol: 'aapl.us', name: 'Apple', market: 'NASDAQ' };
      },
      getDailyCandles: async (symbol) => {
        assert.equal(symbol, 'aapl.us');
        return rows;
      }
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze?symbol=AAPL.US`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.symbol, 'aapl.us');
    assert.equal(body.name, 'Apple');
    assert.equal(body.source, 'Toss Securities');
    assert.equal(body.data.latest.close, 104);
    assert.equal(body.data.periods.oneDay, (104 / 102 - 1) * 100);
  });
});

test('returns 502 when the provider fails', async () => {
  const server = createServer({
    marketClient: {
      resolveSymbol: async () => ({ symbol: 'AAPL', name: 'Apple', market: 'NASDAQ' }),
      getDailyCandles: async () => {
        throw new Error('토스증권 API에 연결할 수 없습니다.');
      }
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze?symbol=AAPL.US`);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.match(body.error, /토스증권 API/);
  });
});

test('accepts a Korean stock name and analyzes its resolved symbol', async () => {
  const server = createServer({
    marketClient: {
      resolveSymbol: async (input) => {
        assert.equal(input, '삼성전자');
        return { symbol: '005930', name: '삼성전자', market: 'KOSPI' };
      },
      getDailyCandles: async (symbol) => {
        assert.equal(symbol, '005930');
        return rows;
      }
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze?symbol=${encodeURIComponent('삼성전자')}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.name, '삼성전자');
    assert.equal(body.symbol, '005930');
    assert.equal(body.market, 'KOSPI');
  });
});

test('returns autocomplete suggestions below the symbol query', async () => {
  const server = createServer({
    marketClient: {
      searchStocks: async (query) => {
        assert.equal(query, '삼성');
        return [
          { symbol: '005930', name: '삼성전자', market: 'KOSPI', marketCap: 500000000000000, currency: 'KRW' },
          { symbol: '006400', name: '삼성SDI', market: 'KOSPI', marketCap: 30000000000000, currency: 'KRW' }
        ];
      },
      resolveSymbol: async () => ({ symbol: '005930', name: '삼성전자', market: 'KOSPI' }),
      getDailyCandles: async () => rows
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search?query=${encodeURIComponent('삼성')}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.matches, [
      { symbol: '005930', name: '삼성전자', market: 'KOSPI', marketCap: 500000000000000, currency: 'KRW' },
      { symbol: '006400', name: '삼성SDI', market: 'KOSPI', marketCap: 30000000000000, currency: 'KRW' }
    ]);
  });
});

test('returns chart candles for a selected interval', async () => {
  const server = createServer({
    marketClient: {
      getCandles: async (symbol, interval, count) => {
        assert.equal(symbol, 'AAPL');
        assert.equal(interval, '1m');
        assert.equal(count, 60);
        return [
          { date: '2026-10-07T00:00:00+09:00', open: 100, high: 105, low: 99, close: 104, volume: 1000 },
          { date: '2026-10-07T00:01:00+09:00', open: 104, high: 106, low: 103, close: 105, volume: 1100 }
        ];
      },
      getSessionOpen: async (symbol) => {
        assert.equal(symbol, 'AAPL');
        return 100;
      },
      getMarketStatus: async () => ({ status: 'open', label: '장중' }),
      searchStocks: async () => [],
      resolveSymbol: async () => ({ symbol: 'AAPL', name: 'Apple', market: 'NASDAQ' }),
      getDailyCandles: async () => rows
    }
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chart?symbol=AAPL&interval=1m&count=60`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.interval, '1m');
    assert.deepEqual(body.marketStatus, { status: 'open', label: '장중' });
    assert.equal(body.data.history[1].close, 105);
    assert.ok(Math.abs(body.data.analysis.sessionReturn - 5) < 1e-10);
  });
});

test('exposes a lightweight health endpoint', async () => {
  const server = createServer({ marketClient: {} });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
  });
});

test('coalesces identical chart requests during the cache window', async () => {
  let upstreamCalls = 0;
  const chartRows = [
    { date: '2026-10-07T00:00:00+09:00', open: 100, high: 101, low: 99, close: 100, volume: 10 },
    { date: '2026-10-07T00:01:00+09:00', open: 100, high: 102, low: 99, close: 101, volume: 20 }
  ];
  const server = createServer({
    marketClient: {
      getCandles: async () => {
        upstreamCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return chartRows;
      },
      getSessionOpen: async () => 100
    }
  });

  await withServer(server, async (baseUrl) => {
    const endpoint = `${baseUrl}/api/chart?symbol=AAPL&interval=1m&count=200`;
    await Promise.all(Array.from({ length: 10 }, () => fetch(endpoint)));
    await fetch(endpoint);
    assert.equal(upstreamCalls, 1);
  });
});

test('rate-limits public API requests per client', async () => {
  const server = createServer({
    marketClient: {
      searchStocks: async () => []
    }
  });

  await withServer(server, async (baseUrl) => {
    const responses = await Promise.all(Array.from({ length: 31 }, () => fetch(`${baseUrl}/api/search?query=삼성`)));
    assert.ok(responses.some((response) => response.status === 429));
  });
});
