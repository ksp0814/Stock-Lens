import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeIntraday, analyzePrices } from './analysis.js';
import { createTossInvestClient } from './tossinvest.js';

const sourceName = 'Toss Securities';
const sourceUrl = 'https://developers.tossinvest.com/docs/market-data';
const defaultPublicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const CHART_CACHE_TTL_MS = 4_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const API_RATE_LIMITS = {
  '/api/search': 30,
  '/api/chart': 30,
  '/api/analyze': 12
};

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function getClientAddress(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function checkRateLimit(request, pathname, buckets) {
  const limit = API_RATE_LIMITS[pathname];
  if (!limit) return null;

  const now = Date.now();
  if (buckets.size > 5_000) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
  const key = `${pathname}:${getClientAddress(request)}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return null;
  }
  if (current.count >= limit) return Math.ceil((current.resetAt - now) / 1000);
  current.count += 1;
  return null;
}

async function serveStatic(response, pathname, publicDir) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end('잘못된 경로입니다.');
    return;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  const filePath = path.resolve(publicDir, relativePath);
  const publicRoot = path.resolve(publicDir);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    response.writeHead(403);
    response.end('접근할 수 없습니다.');
    return;
  }

  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'content-type': contentTypes[extension] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('페이지를 찾을 수 없습니다.');
  }
}

export function createServer({
  fetchImpl = globalThis.fetch,
  publicDir = defaultPublicDir,
  marketClient = createTossInvestClient({ fetchImpl })
} = {}) {
  const chartCache = new Map();
  const chartInflight = new Map();
  const rateLimitBuckets = new Map();

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'GET 요청만 지원합니다.' });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      const retryAfter = checkRateLimit(request, requestUrl.pathname, rateLimitBuckets);
      if (retryAfter !== null) {
        writeJson(response, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, {
          'retry-after': String(retryAfter)
        });
        return;
      }
    }

    if (requestUrl.pathname === '/health') {
      writeJson(response, 200, { status: 'ok', uptime: Math.round(process.uptime()) });
      return;
    }

    if (requestUrl.pathname === '/api/search') {
      try {
        const query = requestUrl.searchParams.get('query');
        const matches = await marketClient.searchStocks(query);
        writeJson(response, 200, {
          query: query?.trim() ?? '',
          matches: matches.map(({ symbol, name, market, marketCap, currency }) => ({
            symbol,
            name,
            market,
            marketCap,
            currency
          }))
        });
      } catch (error) {
        const status = [400, 404, 409].includes(error.status) ? error.status : 502;
        writeJson(response, status, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/chart') {
      try {
        const symbol = requestUrl.searchParams.get('symbol');
        const interval = requestUrl.searchParams.get('interval') ?? '1m';
        const count = Number(requestUrl.searchParams.get('count') ?? 60);
        const cacheKey = `${symbol ?? ''}:${interval}:${count}`;
        const cached = chartCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          writeJson(response, 200, cached.payload);
          return;
        }

        let pending = chartInflight.get(cacheKey);
        if (!pending) {
          pending = (async () => {
            const history = await marketClient.getCandles(symbol, interval, count);
            const sessionOpen = interval === '1m' && typeof marketClient.getSessionOpen === 'function'
              ? await marketClient.getSessionOpen(symbol)
              : null;
            const analysis = interval === '1m' ? analyzeIntraday(history, { sessionOpen }) : null;
            let marketStatus = null;
            if (typeof marketClient.getMarketStatus === 'function') {
              try {
                marketStatus = await marketClient.getMarketStatus(symbol);
              } catch {
                marketStatus = { status: 'unknown', label: '시장 상태 확인 불가' };
              }
            }
            return { symbol, interval, marketStatus, data: { history, analysis } };
          })();
          chartInflight.set(cacheKey, pending);
          pending.finally(() => chartInflight.delete(cacheKey)).catch(() => {});
        }

        const payload = await pending;
        const cacheEntry = { payload, expiresAt: Date.now() + CHART_CACHE_TTL_MS };
        chartCache.set(cacheKey, cacheEntry);
        const cleanupTimer = setTimeout(() => {
          if (chartCache.get(cacheKey) === cacheEntry) chartCache.delete(cacheKey);
        }, CHART_CACHE_TTL_MS);
        cleanupTimer.unref?.();
        writeJson(response, 200, payload);
      } catch (error) {
        const status = [400, 404, 409].includes(error.status) ? error.status : 502;
        writeJson(response, status, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/analyze') {
      const input = requestUrl.searchParams.get('symbol');
      try {
        const resolved = await marketClient.resolveSymbol(input);
        const rows = await marketClient.getDailyCandles(resolved.symbol);
        const data = analyzePrices(rows);
        writeJson(response, 200, {
          input: input?.trim() ?? '',
          symbol: resolved.symbol,
          name: resolved.name,
          market: resolved.market,
          source: sourceName,
          sourceUrl,
          asOf: data.latest.date,
          data
        });
      } catch (error) {
        const status = [400, 404, 409].includes(error.status) ? error.status : 502;
        const body = { error: error.message };
        if (status === 409 && Array.isArray(error.matches)) {
          body.matches = error.matches.map(({ symbol, name, market }) => ({ symbol, name, market }));
        }
        writeJson(response, status, body);
      }
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      writeJson(response, 404, { error: 'API 경로를 찾을 수 없습니다.' });
      return;
    }

    await serveStatic(response, requestUrl.pathname, publicDir);
  });
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFile === invokedFile) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Stock Lens running at http://localhost:${port}`);
  });
}
