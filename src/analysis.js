const SYMBOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,19}$/i;

export function normalizeSymbol(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('종목 코드를 입력해 주세요.');
  }

  const symbol = value.trim().toLowerCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new Error('종목 코드 형식이 올바르지 않습니다. 예: aapl.us');
  }

  return symbol;
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function movingAverage(rows, period) {
  return average(rows.slice(-period).map((row) => row.close));
}

function percentageChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current / previous) - 1) * 100;
}

function periodReturn(rows, period) {
  if (rows.length <= period) return null;
  return percentageChange(rows.at(-1).close, rows.at(-1 - period).close);
}

function annualizedVolatility(rows) {
  const dailyReturns = rows
    .slice(1)
    .map((row, index) => percentageChange(row.close, rows[index].close) / 100)
    .filter((value) => Number.isFinite(value));

  if (dailyReturns.length < 2) return 0;
  const mean = average(dailyReturns);
  const variance = dailyReturns.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (dailyReturns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

function maximumDrawdown(rows) {
  let peak = rows[0].close;
  let drawdown = 0;

  for (const row of rows) {
    peak = Math.max(peak, row.close);
    drawdown = Math.min(drawdown, ((row.close / peak) - 1) * 100);
  }

  return drawdown;
}

function classifyTrend(latestClose, ma20, ma50, threeMonthReturn) {
  if (latestClose > ma20 && ma20 >= ma50 && (threeMonthReturn ?? 0) >= 0) {
    return '상승 추세';
  }
  if (latestClose < ma20 && ma20 <= ma50 && (threeMonthReturn ?? 0) < 0) {
    return '하락 추세';
  }
  return '혼조';
}

function classifyRisk(volatility) {
  if (volatility >= 40) return '높음';
  if (volatility >= 25) return '보통';
  return '낮음';
}

export function analyzePrices(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('분석하려면 두 개 이상의 주가 데이터가 필요합니다.');
  }

  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const ma20 = movingAverage(rows, 20);
  const ma50 = movingAverage(rows, 50);
  const threeMonth = periodReturn(rows, 63);
  const volatilityAnnualized = annualizedVolatility(rows);

  return {
    latest,
    previous,
    periods: {
      oneDay: percentageChange(latest.close, previous.close),
      oneMonth: periodReturn(rows, 21),
      threeMonth,
      oneYear: periodReturn(rows, 252)
    },
    movingAverages: { ma20, ma50 },
    volatilityAnnualized,
    riskLevel: classifyRisk(volatilityAnnualized),
    maxDrawdown: maximumDrawdown(rows),
    trend: classifyTrend(latest.close, ma20, ma50, threeMonth),
    history: rows.slice(-200).map(({ date, open, high, low, close, volume }) => ({ date, open, high, low, close, volume }))
  };
}

function intradayVolatility(rows) {
  const returns = rows
    .slice(1)
    .map((row, index) => percentageChange(row.close, rows[index].close) / 100)
    .filter((value) => Number.isFinite(value));
  if (returns.length < 2) return 0;

  const mean = average(returns);
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (returns.length - 1);
  return Math.sqrt(variance) * 100;
}

function volumeWeightedAveragePrice(rows) {
  let weightedTotal = 0;
  let volumeTotal = 0;
  for (const row of rows) {
    const volume = Number.isFinite(row.volume) ? row.volume : 0;
    const typicalPrice = (row.high + row.low + row.close) / 3;
    weightedTotal += typicalPrice * volume;
    volumeTotal += volume;
  }
  return volumeTotal > 0 ? weightedTotal / volumeTotal : rows.at(-1).close;
}

export function analyzeIntraday(rows, { sessionOpen = null } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('실시간 분석에는 두 개 이상의 분봉 데이터가 필요합니다.');
  }

  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const first = rows[0];
  const ma20 = movingAverage(rows, 20);
  const ma50 = movingAverage(rows, 50);
  const windowReturn = percentageChange(latest.close, first.close);
  const sessionBase = Number.isFinite(sessionOpen) && sessionOpen > 0
    ? sessionOpen
    : (first.open ?? first.close);

  return {
    latest,
    previous,
    first,
    oneBarReturn: percentageChange(latest.close, previous.close),
    windowReturn,
    sessionReturn: percentageChange(latest.close, sessionBase),
    sessionOpen: sessionBase,
    movingAverages: { ma20, ma50 },
    vwap: volumeWeightedAveragePrice(rows),
    volatility: intradayVolatility(rows),
    maxDrawdown: maximumDrawdown(rows),
    high: Math.max(...rows.map((row) => row.high)),
    low: Math.min(...rows.map((row) => row.low)),
    volume: rows.reduce((sum, row) => sum + (Number.isFinite(row.volume) ? row.volume : 0), 0),
    trend: classifyTrend(latest.close, ma20, ma50, windowReturn),
    historyCount: rows.length
  };
}
