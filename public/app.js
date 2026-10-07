import { aggregateHistory, isIntradayMode } from './chart-utils.js';

const form = document.querySelector('#analyze-form');
const input = document.querySelector('#symbol');
const button = document.querySelector('#analyze-button');
const analysisSection = document.querySelector('#analysis');
const emptyState = document.querySelector('#empty-state');
const loadingState = document.querySelector('#loading-state');
const errorState = document.querySelector('#error-state');
const results = document.querySelector('#results');
const suggestionBox = document.querySelector('#symbol-suggestions');
const themeOptions = document.querySelectorAll('[data-theme-choice]');
const chartTabs = document.querySelectorAll('[data-chart-mode]');
let suggestionTimer;
let suggestionController;
let suggestionRequestId = 0;
let suggestionMatches = [];
let activeSuggestionIndex = -1;
let activePayload = null;
let activeChartMode = 'day';
let liveTimer = null;
let liveRequestId = 0;

function getInitialTheme() {
  try {
    const savedTheme = localStorage.getItem('stock-lens-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
  } catch {
    // Private browsing may deny localStorage. Fall back to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

function applyTheme(theme, persist = true) {
  const selectedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selectedTheme;
  themeOptions.forEach((option) => {
    option.setAttribute('aria-pressed', String(option.dataset.themeChoice === selectedTheme));
  });
  if (persist) {
    try {
      localStorage.setItem('stock-lens-theme', selectedTheme);
    } catch {
      // The visual theme still works when persistence is unavailable.
    }
  }
}

applyTheme(getInitialTheme(), false);
themeOptions.forEach((option) => {
  option.addEventListener('click', () => applyTheme(option.dataset.themeChoice));
});

const elements = {
  errorMessage: document.querySelector('#error-message'),
  marketStatus: document.querySelector('#market-status'),
  marketStatusText: document.querySelector('#market-status-text'),
  resultSymbol: document.querySelector('#result-symbol'),
  asOfDate: document.querySelector('#as-of-date'),
  sourceLabel: document.querySelector('#source-label'),
  metricLabelLatest: document.querySelector('#metric-label-latest'),
  metricLabelOneDay: document.querySelector('#metric-label-one-day'),
  metricHintOneDay: document.querySelector('#metric-hint-one-day'),
  metricLabelOneMonth: document.querySelector('#metric-label-one-month'),
  metricHintOneMonth: document.querySelector('#metric-hint-one-month'),
  metricLabelThreeMonth: document.querySelector('#metric-label-three-month'),
  metricHintThreeMonth: document.querySelector('#metric-hint-three-month'),
  latestPrice: document.querySelector('#latest-price'),
  latestDate: document.querySelector('#latest-date'),
  oneDayChange: document.querySelector('#one-day-change'),
  oneMonthReturn: document.querySelector('#one-month-return'),
  threeMonthReturn: document.querySelector('#three-month-return'),
  ma20: document.querySelector('#ma20'),
  ma50: document.querySelector('#ma50'),
  volatility: document.querySelector('#volatility'),
  maxDrawdown: document.querySelector('#max-drawdown'),
  trendBadge: document.querySelector('#trend-badge'),
  trendCopy: document.querySelector('#trend-copy'),
  signalLabelMa20: document.querySelector('#signal-label-ma20'),
  signalLabelMa50: document.querySelector('#signal-label-ma50'),
  signalLabelVolatility: document.querySelector('#signal-label-volatility'),
  signalLabelDrawdown: document.querySelector('#signal-label-drawdown'),
  observationList: document.querySelector('#observation-list'),
  priceChart: document.querySelector('#price-chart'),
  chartWindow: document.querySelector('#chart-window'),
  chartStart: document.querySelector('#chart-start'),
  chartEnd: document.querySelector('#chart-end')
};

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '데이터 부족';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value);
}

function formatMarketCap(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '시총 정보 없음';
  if (currency === 'KRW') {
    if (value >= 1e12) return `${(value / 1e12).toFixed(1)}조원`;
    if (value >= 1e8) return `${(value / 1e8).toFixed(1)}억원`;
    return `${formatNumber(value)}원`;
  }
  if (currency === 'USD') {
    if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
    if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
    return `$${formatNumber(value)}`;
  }
  return `${formatNumber(value)} ${currency ?? ''}`.trim();
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '데이터 부족';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function setState(state) {
  emptyState.hidden = state !== 'empty';
  loadingState.hidden = state !== 'loading';
  errorState.hidden = state !== 'error';
  results.hidden = state !== 'results';
  analysisSection.setAttribute('aria-busy', String(state === 'loading'));
}

function colorFor(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function setMetric(element, value, formatter = formatNumber) {
  element.textContent = formatter(value);
  element.classList.remove('positive', 'negative', 'neutral');
  element.classList.add(colorFor(value));
}

function renderMarketStatus(status) {
  const safeStatus = status?.status ?? 'unknown';
  elements.marketStatus.className = `data-badge market-status market-${safeStatus}`;
  elements.marketStatusText.textContent = status?.label ?? '시장 상태 확인 불가';
}

function hideSuggestions() {
  suggestionRequestId += 1;
  suggestionController?.abort();
  suggestionController = null;
  suggestionMatches = [];
  activeSuggestionIndex = -1;
  suggestionBox.hidden = true;
  suggestionBox.replaceChildren();
  suggestionBox.setAttribute('aria-busy', 'false');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function showSuggestionStatus(message) {
  suggestionMatches = [];
  activeSuggestionIndex = -1;
  input.removeAttribute('aria-activedescendant');
  const status = document.createElement('div');
  status.className = 'suggestions-status';
  status.setAttribute('role', 'status');
  status.textContent = message;
  suggestionBox.replaceChildren(status);
  suggestionBox.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function chooseSuggestion(index) {
  const match = suggestionMatches[index];
  if (!match) return;
  input.value = match.name;
  hideSuggestions();
  input.focus();
}

function setActiveSuggestion(index) {
  if (suggestionMatches.length === 0) return;
  activeSuggestionIndex = (index + suggestionMatches.length) % suggestionMatches.length;
  const options = suggestionBox.querySelectorAll('.suggestion-option');
  options.forEach((option, optionIndex) => {
    const isActive = optionIndex === activeSuggestionIndex;
    option.setAttribute('aria-selected', String(isActive));
    if (isActive) {
      option.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', option.id);
    }
  });
}

function renderSuggestions(matches) {
  if (matches.length === 0) {
    showSuggestionStatus('일치하는 종목이 없습니다.');
    return;
  }

  suggestionMatches = matches.slice(0, 8);
  activeSuggestionIndex = -1;
  input.removeAttribute('aria-activedescendant');
  suggestionBox.replaceChildren(...suggestionMatches.map((match, matchIndex) => {
    const option = document.createElement('button');
    const name = document.createElement('strong');
    const symbol = document.createElement('span');
    const marketCap = document.createElement('small');
    option.type = 'button';
    option.className = 'suggestion-option';
    option.id = `suggestion-option-${matchIndex}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.setAttribute('aria-label', `${match.name} ${match.symbol} 분석 대상 선택`);
    name.textContent = match.name;
    symbol.textContent = `${match.symbol} · ${match.market}`;
    marketCap.textContent = `시총 ${formatMarketCap(match.marketCap, match.currency)}`;
    option.append(name, symbol, marketCap);
    option.addEventListener('click', () => chooseSuggestion(matchIndex));
    return option;
  }));
  suggestionBox.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

async function searchSuggestions(query) {
  const normalizedQuery = query.trim();
  const looksLikeCode = /^[a-z0-9._-]+$/i.test(normalizedQuery);
  if (normalizedQuery.length < 2 || looksLikeCode) {
    hideSuggestions();
    return;
  }

  suggestionController?.abort();
  suggestionController = new AbortController();
  const requestId = ++suggestionRequestId;
  suggestionBox.setAttribute('aria-busy', 'true');
  showSuggestionStatus('종목을 찾는 중입니다.');

  try {
    const response = await fetch(`/api/search?query=${encodeURIComponent(normalizedQuery)}`, {
      signal: suggestionController.signal
    });
    const payload = await response.json();
    if (requestId !== suggestionRequestId) return;
    if (!response.ok) throw new Error(payload.error ?? '종목 검색에 실패했습니다.');
    suggestionBox.setAttribute('aria-busy', 'false');
    renderSuggestions(payload.matches ?? []);
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== suggestionRequestId) return;
    showSuggestionStatus('종목 검색을 불러오지 못했습니다.');
  } finally {
    if (requestId === suggestionRequestId) suggestionBox.setAttribute('aria-busy', 'false');
  }
}

function getChartGeometry(history) {
  const width = 760;
  const height = 320;
  const padding = { top: 18, right: 20, bottom: 18, left: 42 };
  const priceBottom = 224;
  const volumeTop = 248;
  const volumeBottom = height - padding.bottom;
  const highs = history.map((point) => point.high ?? point.close).filter(Number.isFinite);
  const lows = history.map((point) => point.low ?? point.close).filter(Number.isFinite);
  const volumes = history.map((point) => point.volume ?? 0).filter(Number.isFinite);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = priceBottom - padding.top;
  const volumeMax = Math.max(...volumes, 1);
  const coordinates = history.map((point, index) => ({
    x: padding.left + (index / Math.max(history.length - 1, 1)) * plotWidth,
    y: padding.top + (1 - (((point.close ?? 0) - min) / range)) * plotHeight
  }));
  const candles = history.map((point, index) => {
    const open = point.open ?? point.close;
    const high = point.high ?? point.close;
    const low = point.low ?? point.close;
    const close = point.close;
    return {
      x: coordinates[index].x,
      openY: padding.top + (1 - ((open - min) / range)) * plotHeight,
      highY: padding.top + (1 - ((high - min) / range)) * plotHeight,
      lowY: padding.top + (1 - ((low - min) / range)) * plotHeight,
      closeY: padding.top + (1 - ((close - min) / range)) * plotHeight,
      volumeHeight: ((point.volume ?? 0) / volumeMax) * (volumeBottom - volumeTop),
      bullish: close >= open
    };
  });
  return { width, height, padding, priceBottom, volumeTop, volumeBottom, min, max, coordinates, candles };
}

function makeChart(history) {
  const { width, height, padding, priceBottom, volumeTop, volumeBottom, min, max, coordinates, candles } = getChartGeometry(history);
  const candleWidth = Math.max(1.2, Math.min(8, ((width - padding.left - padding.right) / Math.max(history.length, 1)) * .62));
  const candleMarkup = candles.map((candle) => {
    const bodyTop = Math.min(candle.openY, candle.closeY);
    const bodyHeight = Math.max(1.5, Math.abs(candle.closeY - candle.openY));
    const colorClass = candle.bullish ? 'candle-up' : 'candle-down';
    return `<line class="candle-wick ${colorClass}" x1="${candle.x.toFixed(2)}" y1="${candle.highY.toFixed(2)}" x2="${candle.x.toFixed(2)}" y2="${candle.lowY.toFixed(2)}"></line><rect class="candle-body ${colorClass}" x="${(candle.x - candleWidth / 2).toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" rx="1"></rect>`;
  }).join('');
  const volumeMarkup = candles.map((candle) => `<rect class="chart-volume-bar ${candle.bullish ? 'candle-up' : 'candle-down'}" x="${(candle.x - candleWidth / 2).toFixed(2)}" y="${(volumeBottom - candle.volumeHeight).toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${candle.volumeHeight.toFixed(2)}" rx="1"></rect>`).join('');
  const last = coordinates.at(-1);

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" focusable="false" aria-hidden="true">
      <line class="chart-grid-line" x1="${padding.left}" y1="${padding.top}" x2="${width - padding.right}" y2="${padding.top}"></line>
      <line class="chart-grid-line" x1="${padding.left}" y1="${(padding.top + priceBottom) / 2}" x2="${width - padding.right}" y2="${(padding.top + priceBottom) / 2}"></line>
      <line class="chart-grid-line" x1="${padding.left}" y1="${priceBottom}" x2="${width - padding.right}" y2="${priceBottom}"></line>
      <line class="chart-volume-divider" x1="${padding.left}" y1="${volumeTop - 8}" x2="${width - padding.right}" y2="${volumeTop - 8}"></line>
      <text class="chart-axis-label" x="2" y="${padding.top + 4}">${formatNumber(max)}</text>
      <text class="chart-axis-label" x="2" y="${priceBottom}">${formatNumber(min)}</text>
      <g class="chart-candles">${candleMarkup}</g>
      <g class="chart-volume">${volumeMarkup}</g>
      <rect class="chart-hover-catcher" x="0" y="0" width="${width}" height="${height}"></rect>
      <line class="chart-hover-line" x1="${last.x}" y1="${padding.top}" x2="${last.x}" y2="${priceBottom}" visibility="hidden"></line>
      <circle class="chart-hover-dot" cx="${last.x}" cy="${last.y}" r="5" visibility="hidden"></circle>
    </svg>`;
}

function bindChartTooltip(history) {
  const svg = elements.priceChart.querySelector('svg');
  const catcher = elements.priceChart.querySelector('.chart-hover-catcher');
  const hoverLine = elements.priceChart.querySelector('.chart-hover-line');
  const hoverDot = elements.priceChart.querySelector('.chart-hover-dot');
  if (!svg || !catcher || !hoverLine || !hoverDot) return;

  const tooltip = document.createElement('div');
  const tooltipDate = document.createElement('span');
  const tooltipPrice = document.createElement('strong');
  const tooltipDetails = document.createElement('span');
  const tooltipVolume = document.createElement('span');
  tooltip.className = 'chart-tooltip';
  tooltipDate.className = 'chart-tooltip-date';
  tooltipPrice.className = 'chart-tooltip-price';
  tooltipDetails.className = 'chart-tooltip-details';
  tooltipVolume.className = 'chart-tooltip-volume';
  tooltip.append(tooltipDate, tooltipPrice, tooltipDetails, tooltipVolume);
  elements.priceChart.append(tooltip);

  const geometry = getChartGeometry(history);
  const hide = () => {
    tooltip.hidden = true;
    hoverLine.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
  };

  catcher.addEventListener('mousemove', (event) => {
    const bounds = svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const index = Math.round(ratio * (history.length - 1));
    const point = history[index];
    const coordinate = geometry.coordinates[index];
    const x = (coordinate.x / geometry.width) * bounds.width;
    const y = (coordinate.y / geometry.height) * bounds.height;

    hoverLine.setAttribute('x1', coordinate.x.toFixed(2));
    hoverLine.setAttribute('x2', coordinate.x.toFixed(2));
    hoverLine.setAttribute('visibility', 'visible');
    hoverDot.setAttribute('cx', coordinate.x.toFixed(2));
    hoverDot.setAttribute('cy', coordinate.y.toFixed(2));
    hoverDot.setAttribute('visibility', 'visible');
    tooltipDate.textContent = point.date.includes('T') ? point.date.slice(0, 16).replace('T', ' ') : point.date;
    tooltipPrice.textContent = formatNumber(point.close);
    tooltipDetails.textContent = `시 ${formatNumber(point.open ?? point.close)} · 고 ${formatNumber(point.high ?? point.close)} · 저 ${formatNumber(point.low ?? point.close)}`;
    tooltipVolume.textContent = `거래량 ${formatNumber(point.volume ?? 0)}`;
    tooltip.hidden = false;
    tooltip.classList.toggle('tooltip-below', coordinate.y < 80);
    tooltip.style.left = `${Math.max(58, Math.min(bounds.width - 58, x))}px`;
    tooltip.style.top = `${Math.max(10, y)}px`;
  });
  catcher.addEventListener('mouseleave', hide);
  hide();
}

function chartDateLabel(value) {
  return value.includes('T') ? value.slice(11, 16) : value;
}

function renderChartHistory(history, mode) {
  if (!history?.length) return;

  elements.priceChart.innerHTML = makeChart(history);
  bindChartTooltip(history);
  elements.priceChart.setAttribute('aria-label', `${activePayload.symbol.toUpperCase()} ${mode} 종가 흐름`);
  elements.chartStart.textContent = chartDateLabel(history[0].date);
  elements.chartEnd.textContent = chartDateLabel(history.at(-1).date);

  const modeLabel = { day: '일봉', week: '주봉', month: '월봉', '1m': '1분봉', '3m': '3분봉', '5m': '5분봉', '10m': '10분봉', '30m': '30분봉' }[mode];
  elements.chartWindow.textContent = isIntradayMode(mode)
    ? `${modeLabel} · 5초 갱신`
    : `${modeLabel} · ${history.length}개`;
}

function stopLiveChart() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  liveRequestId += 1;
}

async function refreshIntradayChart() {
  if (!activePayload || !isIntradayMode(activeChartMode)) return;
  const requestId = ++liveRequestId;
  try {
    const response = await fetch(`/api/chart?symbol=${encodeURIComponent(activePayload.symbol)}&interval=1m&count=200`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? '분봉 차트를 불러오지 못했습니다.');
    if (requestId !== liveRequestId || !isIntradayMode(activeChartMode)) return;
    renderMarketStatus(payload.marketStatus);
    if (payload.data.analysis) {
      renderLiveMetrics(payload.data.analysis);
      renderLiveObservations(payload.data.analysis);
    }
    renderChartHistory(aggregateHistory(payload.data.history, activeChartMode), activeChartMode);
  } catch {
    if (requestId === liveRequestId && isIntradayMode(activeChartMode)) {
      elements.chartWindow.textContent = '분봉 연결 대기';
    }
  }
}

function selectChartMode(mode) {
  if (!activePayload) return;
  activeChartMode = mode;
  chartTabs.forEach((tab) => {
    tab.setAttribute('aria-pressed', String(tab.dataset.chartMode === mode));
  });

  if (isIntradayMode(mode)) {
    stopLiveChart();
    const label = { '1m': '1분봉', '3m': '3분봉', '5m': '5분봉', '10m': '10분봉', '30m': '30분봉' }[mode];
    elements.chartWindow.textContent = `${label} 연결 중…`;
    refreshIntradayChart();
    if (!document.hidden) liveTimer = setInterval(refreshIntradayChart, 5_000);
    return;
  }

  stopLiveChart();
  renderDailyMetrics(activePayload.data, activePayload.source);
  renderObservations(activePayload.data);
  renderChartHistory(aggregateHistory(activePayload.data.history, mode), mode);
}

function setTrend(trend, live = false) {
  elements.trendBadge.textContent = trend;
  elements.trendBadge.className = `trend-badge ${trend === '상승 추세' ? 'trend-up' : trend === '하락 추세' ? 'trend-down' : 'trend-flat'}`;
  elements.trendCopy.textContent = trend === '상승 추세'
    ? `${live ? '최근 분봉' : '최근 종가'}와 이동평균의 배열이 위쪽을 향하고 있습니다. 추세가 계속된다는 뜻은 아니므로 변동성과 거래량을 함께 확인하세요.`
    : trend === '하락 추세'
      ? `${live ? '최근 분봉' : '최근 종가'}와 이동평균의 배열이 아래쪽을 향하고 있습니다. 반등 여부보다 변동성과 낙폭을 먼저 확인하세요.`
      : '단기와 중기 신호가 한 방향으로 모이지 않았습니다. 수익률 하나만으로 방향을 단정하지 마세요.';
}

function renderDailyMetrics(data, source = 'Toss Securities') {
  const { latest, periods, movingAverages, volatilityAnnualized, maxDrawdown, trend } = data;
  elements.sourceLabel.textContent = `${source} 일별 종가`;
  elements.metricLabelLatest.textContent = '최근 종가';
  elements.metricLabelOneDay.textContent = '1일 변화';
  elements.metricHintOneDay.textContent = '전일 종가 대비';
  elements.metricLabelOneMonth.textContent = '1개월 수익률';
  elements.metricHintOneMonth.textContent = '약 21거래일';
  elements.metricLabelThreeMonth.textContent = '3개월 수익률';
  elements.metricHintThreeMonth.textContent = '약 63거래일';
  elements.signalLabelMa20.textContent = '20일 평균';
  elements.signalLabelMa50.textContent = '50일 평균';
  elements.signalLabelVolatility.textContent = '연환산 변동성';
  elements.signalLabelDrawdown.textContent = '최대 낙폭';
  elements.latestPrice.textContent = formatNumber(latest.close);
  elements.latestDate.textContent = latest.date;
  setMetric(elements.oneDayChange, periods.oneDay, formatPercent);
  setMetric(elements.oneMonthReturn, periods.oneMonth, formatPercent);
  setMetric(elements.threeMonthReturn, periods.threeMonth, formatPercent);
  elements.ma20.textContent = formatNumber(movingAverages.ma20);
  elements.ma50.textContent = formatNumber(movingAverages.ma50);
  elements.volatility.textContent = formatPercent(volatilityAnnualized);
  elements.maxDrawdown.textContent = formatPercent(maxDrawdown);
  setTrend(trend);
}

function renderLiveMetrics(data) {
  const { latest, movingAverages, vwap, volatility, maxDrawdown, trend, sessionReturn, windowReturn, historyCount } = data;
  const vwapDeviation = ((latest.close / vwap) - 1) * 100;
  elements.sourceLabel.textContent = 'Toss Securities 실시간 1분봉';
  elements.metricLabelLatest.textContent = '현재가';
  elements.metricLabelOneDay.textContent = '오늘 변화';
  elements.metricHintOneDay.textContent = '오늘 시가 대비';
  elements.metricLabelOneMonth.textContent = '조회 구간 수익률';
  elements.metricHintOneMonth.textContent = `${historyCount}개 1분봉 기준`;
  elements.metricLabelThreeMonth.textContent = 'VWAP 괴리';
  elements.metricHintThreeMonth.textContent = '현재가와 거래량가중평균';
  elements.signalLabelMa20.textContent = '20봉 평균';
  elements.signalLabelMa50.textContent = '50봉 평균';
  elements.signalLabelVolatility.textContent = '분봉 변동성';
  elements.signalLabelDrawdown.textContent = '구간 최대 낙폭';
  elements.latestPrice.textContent = formatNumber(latest.close);
  elements.latestDate.textContent = latest.date.slice(0, 16).replace('T', ' ');
  setMetric(elements.oneDayChange, sessionReturn, formatPercent);
  setMetric(elements.oneMonthReturn, windowReturn, formatPercent);
  setMetric(elements.threeMonthReturn, vwapDeviation, formatPercent);
  elements.ma20.textContent = formatNumber(movingAverages.ma20);
  elements.ma50.textContent = formatNumber(movingAverages.ma50);
  elements.volatility.textContent = formatPercent(volatility);
  elements.maxDrawdown.textContent = formatPercent(maxDrawdown);
  setTrend(trend, true);
}

function renderObservationItems(observations) {
  elements.observationList.replaceChildren(...observations.map((observation) => {
    const item = document.createElement('li');
    item.textContent = observation;
    return item;
  }));
}

function renderObservations(data) {
  const { latest, movingAverages, periods, volatilityAnnualized, maxDrawdown } = data;
  const observations = [];
  const average20Text = latest.close >= movingAverages.ma20
    ? '최근 종가는 20일 이동평균 위에 있습니다.'
    : '최근 종가는 20일 이동평균 아래에 있습니다.';
  const average50Text = latest.close >= movingAverages.ma50
    ? '50일 평균보다 높은 위치입니다.'
    : '50일 평균보다 낮은 위치입니다.';
  observations.push(`${average20Text} ${average50Text}`);
  observations.push(`최근 1개월 수익률은 ${formatPercent(periods.oneMonth)}입니다.`);
  observations.push(`연환산 변동성은 ${formatPercent(volatilityAnnualized)}이며, 과거 가격 변동 폭을 나타냅니다.`);
  observations.push(`선택한 구간의 최대 낙폭은 ${formatPercent(maxDrawdown)}입니다.`);

  renderObservationItems(observations);
}

function renderLiveObservations(data) {
  const { latest, movingAverages, vwap, sessionReturn, windowReturn, high, low, volume } = data;
  const vwapText = latest.close >= vwap ? '현재가는 VWAP 위에 있습니다.' : '현재가는 VWAP 아래에 있습니다.';
  renderObservationItems([
    `${vwapText} 현재가 ${formatNumber(latest.close)}, VWAP ${formatNumber(vwap)}입니다.`,
    `오늘 시가 대비 수익률은 ${formatPercent(sessionReturn)}, 최근 조회 구간 수익률은 ${formatPercent(windowReturn)}입니다.`,
    `분봉 고가는 ${formatNumber(high)}, 저가는 ${formatNumber(low)}입니다.`,
    `누적 거래량은 ${formatNumber(volume)}입니다. 20봉 평균 ${formatNumber(movingAverages.ma20)}과 비교하세요.`
  ]);
}

function renderResults(payload) {
  const { symbol, name, source, asOf, data } = payload;
  elements.resultSymbol.textContent = name ? `${name} · ${symbol.toUpperCase()}` : symbol.toUpperCase();
  elements.asOfDate.textContent = asOf;
  elements.sourceLabel.textContent = `${source} 분석 대기`;
  activePayload = payload;
  renderDailyMetrics(data, source);
  renderObservations(data);
  selectChartMode('1m');
}

async function analyze(symbol) {
  hideSuggestions();
  stopLiveChart();
  setState('loading');
  button.disabled = true;
  button.querySelector('span').textContent = '분석 중';
  try {
    const response = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
    const payload = await response.json();
    if (!response.ok) {
      const matches = Array.isArray(payload.matches)
        ? payload.matches.slice(0, 5).map((match) => `${match.name} (${match.symbol})`).join(', ')
        : '';
      throw new Error(matches ? `${payload.error} 후보: ${matches}` : (payload.error ?? '분석 요청에 실패했습니다.'));
    }
    renderResults(payload);
    setState('results');
  } catch (error) {
    elements.errorMessage.textContent = error.message;
    setState('error');
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = '분석 시작';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  hideSuggestions();
  const symbol = input.value.trim();
  if (!symbol) {
    elements.errorMessage.textContent = '종목 이름 또는 코드를 입력해 주세요. 예: 삼성전자';
    setState('error');
    input.focus();
    return;
  }
  analyze(symbol);
});

input.addEventListener('input', () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(() => searchSuggestions(input.value), 300);
});

input.addEventListener('keydown', (event) => {
  const suggestionsVisible = !suggestionBox.hidden && suggestionMatches.length > 0;
  if (event.key === 'ArrowDown' && suggestionsVisible) {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex + 1);
  } else if (event.key === 'ArrowUp' && suggestionsVisible) {
    event.preventDefault();
    setActiveSuggestion(activeSuggestionIndex - 1);
  } else if (event.key === 'Enter' && suggestionsVisible && activeSuggestionIndex >= 0) {
    event.preventDefault();
    chooseSuggestion(activeSuggestionIndex);
  } else if (event.key === 'Escape') {
    hideSuggestions();
  }
});

document.addEventListener('click', (event) => {
  if (!form.contains(event.target)) hideSuggestions();
});

document.querySelectorAll('.quick-pick').forEach((quickPick) => {
  quickPick.addEventListener('click', () => {
    input.value = quickPick.dataset.symbol;
    hideSuggestions();
    analyze(input.value);
  });
});

chartTabs.forEach((tab) => {
  tab.addEventListener('click', () => selectChartMode(tab.dataset.chartMode));
});

window.addEventListener('beforeunload', stopLiveChart);

document.addEventListener('visibilitychange', () => {
  if (!activePayload || !isIntradayMode(activeChartMode)) return;
  if (document.hidden) {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    return;
  }
  refreshIntradayChart();
  if (!liveTimer) liveTimer = setInterval(refreshIntradayChart, 5_000);
});


// 아니면 아니지 아니랍니다~
// 하나면 하나두 둘이랍니다~
// 둘이면 둘이지 셋이랍니다~
// 셋이면 셋이지 넷이랍니다~
// 퇴근하고 뭐하지 오늘은 일찍 자고 싶은데
// 집가서 그냥 냅다 씻고 자버릴까
