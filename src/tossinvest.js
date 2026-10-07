import { normalizeSymbol } from './analysis.js';

const BASE_URL = 'https://openapi.tossinvest.com';
const TOKEN_PATH = '/oauth2/token';
const CANDLE_PATH = '/api/v1/candles';
const MARKET_CALENDAR_PATH = '/api/v1/market-calendar';
const STOCK_UNIVERSE_PATH = '/api/v1/stocks/all';
const STOCK_INFO_PATH = '/api/v1/stocks';
const PRICES_PATH = '/api/v1/prices';
const CANDLE_COUNT = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const STOCK_UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_CAP_TTL_MS = 5 * 60 * 1000;
const STOCK_UNIVERSE_INTERVAL_MS = 1_050;
const KOREAN_MARKETS = ['KOSPI', 'KOSDAQ'];
const US_MARKETS = ['NYSE', 'NASDAQ', 'AMEX'];
const NAME_ALIASES = [
  { aliases: ['네이버', 'naver'], symbol: '035420', name: '네이버', market: 'KOSPI', currency: 'KRW' }
];

class TossInvestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'TossInvestError';
    this.status = status;
  }
}

class AmbiguousStockError extends TossInvestError {
  constructor(matches) {
    super('입력한 종목명과 일치하는 종목이 여러 개입니다. 정확한 이름을 입력해 주세요.', 409);
    this.matches = matches;
  }
}

export function normalizeTossSymbol(value) {
  const normalized = normalizeSymbol(value);
  const suffix = normalized.match(/^(.*)\.(kr|us)$/i);

  if (normalized.includes('.') && !suffix) {
    throw new Error('토스증권이 지원하지 않는 시장 표기입니다. 예: 005930.KR 또는 AAPL.US');
  }

  return (suffix ? suffix[1] : normalized).toUpperCase();
}

export function parseTossCandles(payload, { preserveTimestamp = false } = {}) {
  const candles = payload?.result?.candles;
  if (!Array.isArray(candles) || candles.length < 2) {
    throw new Error('토스증권에서 분석할 캔들 데이터가 부족합니다.');
  }

  const rows = candles
    .map((candle) => ({
      date: preserveTimestamp ? String(candle.timestamp ?? '') : String(candle.timestamp ?? '').slice(0, 10),
      open: Number(candle.openPrice),
      high: Number(candle.highPrice),
      low: Number(candle.lowPrice),
      close: Number(candle.closePrice),
      volume: Number(candle.volume)
    }))
    .filter((row) => row.date && Object.values(row).slice(1).every(Number.isFinite))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length < 2) {
    throw new Error('토스증권에서 유효한 캔들 데이터가 없습니다.');
  }

  return rows;
}

export function classifyMarketStatus(calendar, marketCountry = 'KR', now = new Date()) {
  const today = calendar?.result?.today;
  const sessions = marketCountry === 'KR'
    ? [
        { data: today?.integrated?.preMarket, status: 'pre', label: '장 시작 전' },
        { data: today?.integrated?.regularMarket, status: 'open', label: '장중' },
        { data: today?.integrated?.afterMarket, status: 'after', label: '장후 거래' }
      ]
    : [
        { data: today?.dayMarket, status: 'open', label: '장중' },
        { data: today?.preMarket, status: 'pre', label: '장 시작 전' },
        { data: today?.regularMarket, status: 'open', label: '장중' },
        { data: today?.afterMarket, status: 'after', label: '장후 거래' }
      ];
  const validSessions = sessions
    .filter(({ data }) => data?.startTime && data?.endTime)
    .map((session) => ({ ...session, start: Date.parse(session.data.startTime), end: Date.parse(session.data.endTime) }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end))
    .sort((left, right) => left.start - right.start);

  if (validSessions.length === 0) return { status: 'closed', label: '휴장' };
  const timestamp = now.getTime();
  const active = validSessions.find(({ start, end }) => timestamp >= start && timestamp < end);
  if (active) return { status: active.status, label: active.label };
  if (timestamp < validSessions[0].start) return { status: 'pre', label: '장 시작 전' };
  return { status: 'closed', label: '장 마감' };
}

function safeProviderMessage(status, isTokenRequest = false) {
  if (status === 401) {
    return isTokenRequest
      ? '토스증권 인증에 실패했습니다. client_id와 client_secret을 확인해 주세요.'
      : '토스증권 액세스 토큰이 유효하지 않습니다.';
  }
  if (status === 403) return '토스증권 API 호출이 차단되었습니다. Open API 허용 IP를 확인해 주세요.';
  if (status === 404) return '토스증권에서 해당 종목을 찾지 못했습니다.';
  if (status === 429) return '토스증권 API 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
  if (status >= 400 && status < 500) return '토스증권 API 요청이 올바르지 않습니다.';
  return '토스증권 API 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.';
}

function normalizeSearchQuery(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TossInvestError('종목 이름 또는 코드를 입력해 주세요.', 400);
  }

  const query = value.trim();
  if (query.length > 60 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new TossInvestError('종목 검색어는 60자 이내로 입력해 주세요.', 400);
  }

  return query.toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
}

function toResolvedStock(stock) {
  return {
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market
  };
}

function getNameAliasMatches(query) {
  return NAME_ALIASES
    .filter((stock) => stock.aliases.some((alias) => {
      const normalizedAlias = normalizeSearchQuery(alias);
      return normalizedAlias.includes(query) || query.includes(normalizedAlias);
    }))
    .map(({ aliases, ...stock }) => ({ ...stock, marketCap: null }));
}

async function requestWithTimeout(fetchImpl, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch {
    throw new TossInvestError('토스증권 API에 연결할 수 없습니다. 네트워크와 허용 IP를 확인해 주세요.');
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createTossInvestClient({
  fetchImpl = globalThis.fetch,
  clientId = process.env.TOSSINVEST_CLIENT_ID,
  clientSecret = process.env.TOSSINVEST_CLIENT_SECRET,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API를 사용할 수 없습니다. Node.js 18 이상이 필요합니다.');
  }

  let cachedToken = null;
  let lastUniverseRequestAt = 0;
  const universeCache = new Map();
  const marketCapCache = new Map();
  const sessionOpenCache = new Map();
  const marketStatusCache = new Map();

  async function issueToken() {
    if (!clientId || !clientSecret) {
      throw new TossInvestError('토스증권 API 자격증명이 설정되지 않았습니다. TOSSINVEST_CLIENT_ID와 TOSSINVEST_CLIENT_SECRET을 설정해 주세요.');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });
    const response = await requestWithTimeout(fetchImpl, `${BASE_URL}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const payload = await readJson(response);

    if (!response.ok || typeof payload?.access_token !== 'string') {
      throw new TossInvestError(safeProviderMessage(response.status, true), response.status);
    }

    const expiresIn = Number(payload.expires_in);
    cachedToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max((Number.isFinite(expiresIn) ? expiresIn : 3600) - 60, 10) * 1000
    };
    return cachedToken.value;
  }

  async function getToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    return issueToken();
  }

  async function getStockUniverse(market) {
    const cached = universeCache.get(market);
    if (cached && cached.expiresAt > Date.now()) return cached.stocks;

    const elapsed = Date.now() - lastUniverseRequestAt;
    const waitMilliseconds = Math.max(0, STOCK_UNIVERSE_INTERVAL_MS - elapsed);
    if (waitMilliseconds > 0) await sleepImpl(waitMilliseconds);

    const token = await getToken();
    const endpoint = new URL(`${BASE_URL}${STOCK_UNIVERSE_PATH}`);
    endpoint.searchParams.set('market', market);
    endpoint.searchParams.set('status', 'ACTIVE');
    lastUniverseRequestAt = Date.now();
    const response = await requestWithTimeout(fetchImpl, endpoint, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const payload = await readJson(response);

    if (!response.ok || !Array.isArray(payload?.result)) {
      throw new TossInvestError(safeProviderMessage(response.status), response.status);
    }

    const stocks = payload.result
      .filter((stock) => typeof stock?.symbol === 'string' && typeof stock?.name === 'string')
      .map((stock) => ({
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market ?? market,
        securityType: stock.securityType,
        isCommonShare: stock.isCommonShare
      }));
    universeCache.set(market, { stocks, expiresAt: Date.now() + STOCK_UNIVERSE_TTL_MS });
    return stocks;
  }

  async function enrichMarketCaps(stocks) {
    const targets = stocks.slice(0, 200);
    const missing = targets.filter((stock) => {
      const cached = marketCapCache.get(stock.symbol);
      return !cached || cached.expiresAt <= Date.now();
    });

    if (missing.length > 0) {
      const token = await getToken();
      const symbols = missing.map((stock) => stock.symbol).join(',');
      const infoEndpoint = new URL(`${BASE_URL}${STOCK_INFO_PATH}`);
      infoEndpoint.searchParams.set('symbols', symbols);
      const infoResponse = await requestWithTimeout(fetchImpl, infoEndpoint, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
      });
      const infoPayload = await readJson(infoResponse);
      if (!infoResponse.ok || !Array.isArray(infoPayload?.result)) {
        throw new TossInvestError(safeProviderMessage(infoResponse.status), infoResponse.status);
      }

      const priceEndpoint = new URL(`${BASE_URL}${PRICES_PATH}`);
      priceEndpoint.searchParams.set('symbols', symbols);
      const priceResponse = await requestWithTimeout(fetchImpl, priceEndpoint, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
      });
      const pricePayload = await readJson(priceResponse);
      if (!priceResponse.ok || !Array.isArray(pricePayload?.result)) {
        throw new TossInvestError(safeProviderMessage(priceResponse.status), priceResponse.status);
      }

      const infoBySymbol = new Map(infoPayload.result.map((item) => [item.symbol, item]));
      const priceBySymbol = new Map(pricePayload.result.map((item) => [item.symbol, item]));
      for (const stock of missing) {
        const info = infoBySymbol.get(stock.symbol);
        const price = priceBySymbol.get(stock.symbol);
        const sharesOutstanding = Number(info?.sharesOutstanding);
        const lastPrice = Number(price?.lastPrice);
        marketCapCache.set(stock.symbol, {
          marketCap: Number.isFinite(sharesOutstanding) && Number.isFinite(lastPrice)
            ? sharesOutstanding * lastPrice
            : null,
          currency: price?.currency ?? null,
          expiresAt: Date.now() + MARKET_CAP_TTL_MS
        });
      }
    }

    return targets.map((stock) => ({
      ...stock,
      marketCap: marketCapCache.get(stock.symbol)?.marketCap ?? null,
      currency: marketCapCache.get(stock.symbol)?.currency ?? null
    }));
  }

  async function searchStocks(query) {
    const normalizedQuery = normalizeSearchQuery(query);
    const aliasMatches = getNameAliasMatches(normalizedQuery);
    if (aliasMatches.length > 0) {
      try {
        return await enrichMarketCaps(aliasMatches);
      } catch {
        return aliasMatches;
      }
    }

    const primaryMarkets = /[가-힣]/.test(query) ? KOREAN_MARKETS : US_MARKETS;
    const stocks = [];
    for (const market of primaryMarkets) {
      stocks.push(...await getStockUniverse(market));
    }

    if (stocks.every((stock) => !normalizeSearchQuery(stock.name).includes(normalizedQuery))) {
      const fallbackMarkets = [...KOREAN_MARKETS, ...US_MARKETS]
        .filter((market) => !primaryMarkets.includes(market));
      for (const market of fallbackMarkets) {
        stocks.push(...await getStockUniverse(market));
      }
    }

    const matches = stocks.filter((stock) => {
        const normalizedName = normalizeSearchQuery(stock.name);
        return normalizedName.includes(normalizedQuery);
      });
    const enrichedMatches = await enrichMarketCaps(matches);

    return enrichedMatches
      .sort((left, right) => {
        const leftCap = Number.isFinite(left.marketCap) ? left.marketCap : null;
        const rightCap = Number.isFinite(right.marketCap) ? right.marketCap : null;
        if (leftCap !== null || rightCap !== null) {
          if (leftCap === null) return 1;
          if (rightCap === null) return -1;
          if (rightCap !== leftCap) return rightCap - leftCap;
        }
        const leftName = normalizeSearchQuery(left.name);
        const rightName = normalizeSearchQuery(right.name);
        const leftScore = leftName === normalizedQuery ? 0 : leftName.startsWith(normalizedQuery) ? 1 : 2;
        const rightScore = rightName === normalizedQuery ? 0 : rightName.startsWith(normalizedQuery) ? 1 : 2;
        return leftScore - rightScore || left.name.localeCompare(right.name, 'ko');
      })
      .slice(0, 20);
  }

  async function resolveSymbol(input) {
    const query = normalizeSearchQuery(input);
    const aliasMatches = getNameAliasMatches(query);
    if (aliasMatches.length === 1) return toResolvedStock(aliasMatches[0]);

    try {
      return { symbol: normalizeTossSymbol(input), name: null, market: null };
    } catch {
      const matches = await searchStocks(query);
      if (matches.length === 0) {
        throw new TossInvestError('입력한 종목명을 찾지 못했습니다. 정확한 종목명을 입력해 주세요.', 404);
      }
      if (matches.length === 1) return toResolvedStock(matches[0]);

      const exactMatches = matches.filter((stock) => normalizeSearchQuery(stock.name) === query);
      if (exactMatches.length === 1) return toResolvedStock(exactMatches[0]);
      throw new AmbiguousStockError(matches);
    }
  }

  async function getCandles(inputSymbol, interval = '1d', count = interval === '1d' ? CANDLE_COUNT : 60) {
    if (!['1d', '1m'].includes(interval)) {
      throw new TossInvestError('지원하지 않는 차트 간격입니다.', 400);
    }

    const symbol = normalizeTossSymbol(inputSymbol);
    const normalizedCount = Math.min(Math.max(Number(count) || 1, 1), 200);
    let token = await getToken();
    const endpoint = new URL(`${BASE_URL}${CANDLE_PATH}`);
    endpoint.searchParams.set('symbol', symbol);
    endpoint.searchParams.set('interval', interval);
    endpoint.searchParams.set('count', String(normalizedCount));
    endpoint.searchParams.set('adjusted', 'true');

    let response = await requestWithTimeout(fetchImpl, endpoint, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });

    if (response.status === 401) {
      cachedToken = null;
      token = await issueToken();
      response = await requestWithTimeout(fetchImpl, endpoint, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
      });
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw new TossInvestError(safeProviderMessage(response.status), response.status);
    }

    return parseTossCandles(payload, { preserveTimestamp: interval === '1m' });
  }

  async function getDailyCandles(inputSymbol) {
    return getCandles(inputSymbol, '1d', CANDLE_COUNT);
  }

  async function getSessionOpen(inputSymbol) {
    const symbol = normalizeTossSymbol(inputSymbol);
    const cached = sessionOpenCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const dailyRows = await getCandles(symbol, '1d', 2);
    const latestDaily = dailyRows.at(-1);
    if (!latestDaily || !Number.isFinite(latestDaily.open)) {
      throw new TossInvestError('오늘 시가를 가져오지 못했습니다.');
    }

    sessionOpenCache.set(symbol, { value: latestDaily.open, expiresAt: Date.now() + 60_000 });
    return latestDaily.open;
  }

  async function getMarketStatus(inputSymbol) {
    const symbol = normalizeTossSymbol(inputSymbol);
    const marketCountry = /^\d{6}$/.test(symbol) ? 'KR' : 'US';
    const cached = marketStatusCache.get(marketCountry);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const token = await getToken();
    const endpoint = `${BASE_URL}${MARKET_CALENDAR_PATH}/${marketCountry}`;
    const response = await requestWithTimeout(fetchImpl, endpoint, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
    });
    const payload = await readJson(response);
    if (!response.ok || !payload?.result) {
      throw new TossInvestError(safeProviderMessage(response.status), response.status);
    }

    const status = classifyMarketStatus(payload, marketCountry);
    marketStatusCache.set(marketCountry, { value: status, expiresAt: Date.now() + 30_000 });
    return status;
  }

  return { getDailyCandles, getCandles, getSessionOpen, getMarketStatus, searchStocks, resolveSymbol };
}
