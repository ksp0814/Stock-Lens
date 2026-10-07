import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTossInvestClient,
  classifyMarketStatus,
  normalizeTossSymbol,
  parseTossCandles
} from '../src/tossinvest.js';

const candleResponse = {
  result: {
    candles: [
      {
        timestamp: '2026-10-07T00:00:00+09:00',
        openPrice: '110',
        highPrice: '115',
        lowPrice: '109',
        closePrice: '112',
        volume: '1200',
        currency: 'KRW'
      },
      {
        timestamp: '2026-10-06T00:00:00+09:00',
        openPrice: '100',
        highPrice: '111',
        lowPrice: '99',
        closePrice: '110',
        volume: '1000',
        currency: 'KRW'
      }
    ],
    nextBefore: '2026-10-06T00:00:00+09:00'
  }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('maps the UI ticker format to Toss Securities symbols', () => {
  assert.equal(normalizeTossSymbol('005930.KR'), '005930');
  assert.equal(normalizeTossSymbol('aapl.us'), 'AAPL');
  assert.equal(normalizeTossSymbol('AAPL'), 'AAPL');
  assert.throws(() => normalizeTossSymbol('AAPL.LON'), /지원하지 않는 시장/);
});

test('maps Toss candles from newest-first response to ascending OHLCV rows', () => {
  assert.deepEqual(parseTossCandles(candleResponse), [
    { date: '2026-10-06', open: 100, high: 111, low: 99, close: 110, volume: 1000 },
    { date: '2026-10-07', open: 110, high: 115, low: 109, close: 112, volume: 1200 }
  ]);
  assert.throws(() => parseTossCandles({ result: { candles: [] } }), /데이터/);
});

test('classifies Korean market session status from the calendar', () => {
  const calendar = {
    result: {
      today: {
        integrated: {
          preMarket: { startTime: '2026-10-07T08:00:00+09:00', endTime: '2026-10-07T09:00:00+09:00' },
          regularMarket: { startTime: '2026-10-07T09:00:00+09:00', endTime: '2026-10-07T15:30:00+09:00' },
          afterMarket: { startTime: '2026-10-07T15:30:00+09:00', endTime: '2026-10-07T20:00:00+09:00' }
        }
      }
    }
  };

  assert.deepEqual(classifyMarketStatus(calendar, 'KR', new Date('2026-10-07T10:00:00+09:00')), {
    status: 'open',
    label: '장중'
  });
  assert.deepEqual(classifyMarketStatus(calendar, 'KR', new Date('2026-10-07T16:00:00+09:00')), {
    status: 'after',
    label: '장후 거래'
  });
  assert.deepEqual(classifyMarketStatus(calendar, 'KR', new Date('2026-10-07T22:00:00+09:00')), {
    status: 'closed',
    label: '장 마감'
  });
});

test('issues one token request, caches it, and fetches daily candles', async () => {
  const calls = [];
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-test', token_type: 'Bearer', expires_in: 3600 });
      }
      return jsonResponse(candleResponse);
    }
  });

  const first = await client.getDailyCandles('005930.KR');
  const second = await client.getDailyCandles('005930.KR');

  assert.equal(first.at(-1).close, 112);
  assert.equal(second.at(0).date, '2026-10-06');
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((call) => call.url.endsWith('/oauth2/token')).length, 1);
  const candleCall = calls.find((call) => call.url.includes('/api/v1/candles'));
  assert.match(candleCall.url, /symbol=005930/);
  assert.match(candleCall.url, /interval=1d/);
  assert.match(candleCall.url, /count=200/);
  assert.equal(candleCall.options.headers.Authorization, 'Bearer token-test');
});

test('fetches selectable one-minute candles with the generic candle client', async () => {
  let candleUrl = '';
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    fetchImpl: async (url) => {
      const urlString = String(url);
      if (urlString.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-test', expires_in: 3600 });
      }
      candleUrl = urlString;
      return jsonResponse(candleResponse);
    }
  });

  const rows = await client.getCandles('AAPL.US', '1m', 60);

  assert.equal(rows.at(-1).date, '2026-10-07T00:00:00+09:00');
  assert.match(candleUrl, /symbol=AAPL/);
  assert.match(candleUrl, /interval=1m/);
  assert.match(candleUrl, /count=60/);
});

test('fails before network access when credentials are missing', async () => {
  let called = false;
  const client = createTossInvestClient({
    fetchImpl: async () => {
      called = true;
      return jsonResponse(candleResponse);
    }
  });

  await assert.rejects(() => client.getDailyCandles('AAPL.US'), /자격증명/);
  assert.equal(called, false);
});

test('turns Toss authentication errors into safe messages', async () => {
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    fetchImpl: async () => jsonResponse({
      error: 'access_denied',
      error_description: 'IP address not allowed'
    }, 403)
  });

  await assert.rejects(() => client.getDailyCandles('AAPL.US'), /허용 IP/);
});

test('resolves a Korean stock name through the cached market universe', async () => {
  const calls = [];
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const urlString = String(url);
      calls.push(urlString);
      if (urlString.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-test', expires_in: 3600 });
      }

      const market = new URL(urlString).searchParams.get('market');
      return jsonResponse({
        result: market === 'KOSPI'
          ? [{ symbol: '005930', name: '삼성전자', securityType: 'STOCK', isCommonShare: true, isinCode: 'KR7005930003' }]
          : []
      });
    }
  });

  const resolved = await client.resolveSymbol('삼성전자');

  assert.deepEqual(resolved, { symbol: '005930', name: '삼성전자', market: 'KOSPI' });
  assert.equal(calls.filter((url) => url.includes('/api/v1/stocks/all')).length, 2);
});

test('does not choose arbitrarily when a name has multiple matches', async () => {
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const urlString = String(url);
      if (urlString.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-test', expires_in: 3600 });
      }
      const market = new URL(urlString).searchParams.get('market');
      return jsonResponse({
        result: market === 'KOSPI'
          ? [
              { symbol: '005930', name: '삼성전자', securityType: 'STOCK', isCommonShare: true, isinCode: 'KR7005930003' },
              { symbol: '006400', name: '삼성SDI', securityType: 'STOCK', isCommonShare: true, isinCode: 'KR7006400006' }
            ]
          : []
      });
    }
  });

  await assert.rejects(() => client.resolveSymbol('삼성'), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.matches.length, 2);
    return true;
  });
});

test('sorts name suggestions by market cap descending', async () => {
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const urlString = String(url);
      if (urlString.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'token-test', expires_in: 3600 });
      }
      if (urlString.includes('/api/v1/stocks/all')) {
        const market = new URL(urlString).searchParams.get('market');
        return jsonResponse({
          result: market === 'KOSPI'
            ? [
                { symbol: '000001', name: '삼성큰회사', securityType: 'STOCK', isCommonShare: true },
                { symbol: '000002', name: '삼성작은회사', securityType: 'STOCK', isCommonShare: true }
              ]
            : []
        });
      }
      if (urlString.includes('/api/v1/stocks?')) {
        return jsonResponse({
          result: [
            { symbol: '000001', sharesOutstanding: '1000' },
            { symbol: '000002', sharesOutstanding: '2000' }
          ]
        });
      }
      if (urlString.includes('/api/v1/prices?')) {
        return jsonResponse({
          result: [
            { symbol: '000001', lastPrice: '100', currency: 'KRW' },
            { symbol: '000002', lastPrice: '10', currency: 'KRW' }
          ]
        });
      }
      return jsonResponse({ result: [] });
    }
  });

  const matches = await client.searchStocks('삼성');

  assert.deepEqual(matches.slice(0, 2).map((stock) => stock.symbol), ['000001', '000002']);
  assert.equal(matches[0].marketCap, 100000);
  assert.equal(matches[0].currency, 'KRW');
});

test('resolves Naver by its Korean and English display aliases', async () => {
  const client = createTossInvestClient({
    clientId: 'client-test',
    clientSecret: 'secret-test',
    fetchImpl: async () => {
      throw new Error('alias lookup should not require the universe request');
    }
  });

  const korean = await client.resolveSymbol('네이버');
  const english = await client.searchStocks('NAVER');

  assert.deepEqual(korean, { symbol: '035420', name: '네이버', market: 'KOSPI' });
  assert.equal(english[0].symbol, '035420');
});
