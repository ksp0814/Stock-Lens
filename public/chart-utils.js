const INTRADAY_MINUTES = new Map([
  ['1m', 1],
  ['3m', 3],
  ['5m', 5],
  ['10m', 10],
  ['30m', 30]
]);

export function isIntradayMode(mode) {
  return INTRADAY_MINUTES.has(mode);
}

export function intradayMinutes(mode) {
  return INTRADAY_MINUTES.get(mode) ?? null;
}

function weekStart(dateValue) {
  const date = new Date(`${dateValue.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateValue.slice(0, 10);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function aggregateIntraday(history, minutes) {
  const groups = new Map();
  const bucketSize = minutes * 60 * 1000;

  history.forEach((point) => {
    const timestamp = Date.parse(point.date);
    const key = Number.isFinite(timestamp)
      ? Math.floor(timestamp / bucketSize)
      : point.date;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        date: point.date,
        open: point.open ?? point.close,
        high: point.high ?? point.close,
        low: point.low ?? point.close,
        close: point.close,
        volume: point.volume ?? 0
      });
      return;
    }
    current.high = Math.max(current.high, point.high ?? point.close);
    current.low = Math.min(current.low, point.low ?? point.close);
    current.close = point.close;
    current.volume += point.volume ?? 0;
  });

  return [...groups.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function aggregateHistory(history, mode) {
  if (!Array.isArray(history) || mode === 'day') return history ?? [];
  if (isIntradayMode(mode)) return aggregateIntraday(history, intradayMinutes(mode));

  const groups = new Map();
  history.forEach((point) => {
    const key = mode === 'month' ? point.date.slice(0, 7) : weekStart(point.date);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        date: point.date,
        open: point.open ?? point.close,
        high: point.high ?? point.close,
        low: point.low ?? point.close,
        close: point.close,
        volume: point.volume ?? 0
      });
      return;
    }
    current.high = Math.max(current.high, point.high ?? point.close);
    current.low = Math.min(current.low, point.low ?? point.close);
    current.close = point.close;
    current.volume += point.volume ?? 0;
  });
  return [...groups.values()];
}
