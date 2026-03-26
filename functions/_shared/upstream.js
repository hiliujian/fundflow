import { normalizeFundCode, normalizeFundCodes } from './http.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; FundFlow/2.0; +https://fundflow.pages.dev)';

const MARKET_INDICES = {
  sh000001: { name: '上证指数', secid: '1.000001', type: 'cn' },
  sz399001: { name: '深证成指', secid: '0.399001', type: 'cn' },
  sz399006: { name: '创业板指', secid: '0.399006', type: 'cn' },
  us_dji: { name: '道琼斯', secid: '100.DJIA', type: 'us' },
  us_ixic: { name: '纳斯达克', secid: '100.NDX', type: 'us' },
  us_spx: { name: '标普500', secid: '100.SPX', type: 'us' }
};

function upstreamFetch(url) {
  return fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json,text/javascript,text/plain,*/*'
    }
  });
}

function parseJsonpPayload(text) {
  const trimmed = String(text ?? '').trim();
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Invalid JSONP payload');
  }
  return JSON.parse(trimmed.slice(start + 1, end));
}

function extractVariable(script, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`var\\s+${escaped}\\s*=\\s*([\\s\\S]*?);`);
  const match = String(script ?? '').match(pattern);
  return match ? match[1] : null;
}

function toDateString(input) {
  if (!input) return '';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) {
    return input.slice(0, 10);
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function parsePercent(value) {
  const numeric = Number.parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function getOfficialGrowthFromHistory(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  const prevValue = Number(previous?.y);
  const latestValue = Number(latest?.y);
  if (!Number.isFinite(prevValue) || !Number.isFinite(latestValue) || prevValue === 0) {
    return null;
  }
  return {
    date: toDateString(latest.x),
    dayGrowthPct: Number((((latestValue - prevValue) / prevValue) * 100).toFixed(2)),
    nav: latestValue
  };
}

function extractBaiduNewest(items) {
  if (!Array.isArray(items)) return null;
  const dayItem = items.find((item) => String(item?.text ?? '').includes('日涨幅'));
  const navItem = items.find((item) => String(item?.text ?? '').includes('净值'));
  const dateMatch = String(dayItem?.text ?? '').match(/(\d{2})-(\d{2})/);
  return {
    dateLabel: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}` : '',
    dayGrowthPct: parsePercent(dayItem?.value),
    nav: Number.parseFloat(String(navItem?.value ?? ''))
  };
}

function findNewestNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, 'newest')) {
    return node.newest;
  }
  for (const value of Object.values(node)) {
    const nested = findNewestNode(value);
    if (nested) return nested;
  }
  return null;
}

export async function fetchFundSuggest(keyword) {
  const key = String(keyword ?? '').trim();
  if (!key) return [];
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(key)}`;
  const response = await upstreamFetch(url);
  if (!response.ok) throw new Error(`Suggest upstream failed: ${response.status}`);
  const payload = await response.json();
  const items = Array.isArray(payload?.Datas) ? payload.Datas : [];
  return items
    .map((item) => {
      const code = normalizeFundCode(item?.CODE || item?.FCODE || item?.code);
      const name = String(item?.NAME || item?.SHORTNAME || item?.name || '').trim();
      const type = String(item?.JJType || item?.type || '').trim();
      return code && name ? { code, name, type } : null;
    })
    .filter(Boolean)
    .slice(0, 12);
}

export async function fetchPingZhongData(code) {
  const normalizedCode = normalizeFundCode(code);
  if (!normalizedCode) throw new Error('Invalid fund code');

  const url = `https://fund.eastmoney.com/pingzhongdata/${normalizedCode}.js?v=${Date.now()}`;
  const response = await upstreamFetch(url);
  if (!response.ok) throw new Error(`History upstream failed: ${response.status}`);

  const script = await response.text();
  const nameLiteral = extractVariable(script, 'fS_name');
  const historyLiteral = extractVariable(script, 'Data_netWorthTrend');
  if (!nameLiteral || !historyLiteral) {
    throw new Error('Pingzhongdata payload is incomplete');
  }

  const name = JSON.parse(nameLiteral);
  const history = JSON.parse(historyLiteral).map((item) => ({
    x: item.x,
    y: item.y
  }));

  return {
    code: normalizedCode,
    name,
    history
  };
}

export async function fetchFundSnapshot(code) {
  const normalizedCode = normalizeFundCode(code);
  if (!normalizedCode) throw new Error('Invalid fund code');

  let fundgzData = null;
  try {
    const response = await upstreamFetch(`https://fundgz.1234567.com.cn/js/${normalizedCode}.js?rt=${Date.now()}`);
    if (!response.ok) throw new Error(`FundGZ upstream failed: ${response.status}`);
    fundgzData = parseJsonpPayload(await response.text());
  } catch {
    fundgzData = null;
  }

  const official = await fetchPingZhongData(normalizedCode);
  const latestOfficial = official.history[official.history.length - 1];
  const officialGrowth = getOfficialGrowthFromHistory(official.history);

  const name = String(fundgzData?.name || official.name || normalizedCode);
  const currentNav = Number.parseFloat(String(fundgzData?.dwjz ?? latestOfficial?.y ?? ''));
  const estimatedNav = Number.parseFloat(String(fundgzData?.gsz ?? currentNav));
  const navDate = String(fundgzData?.jzrq || toDateString(latestOfficial?.x));
  const date = toDateString(fundgzData?.gztime || navDate);
  const dayGrowthPct = Number.parseFloat(
    String(
      fundgzData?.gszzl ??
        officialGrowth?.dayGrowthPct ??
        0
    )
  );

  return {
    code: normalizedCode,
    name,
    dwjz: Number.isFinite(currentNav) ? currentNav.toFixed(4) : '',
    jzrq: navDate,
    gsz: Number.isFinite(estimatedNav) ? estimatedNav.toFixed(4) : '',
    gszzl: Number.isFinite(dayGrowthPct) ? dayGrowthPct.toFixed(2) : '0.00',
    gztime: String(fundgzData?.gztime || `${navDate} 15:00`),
    source: fundgzData ? 'fundgz_json' : 'pingzhongdata_script',
    dayGrowthPct: Number.isFinite(dayGrowthPct) ? dayGrowthPct : 0,
    date,
    nav: Number.isFinite(estimatedNav) ? estimatedNav : currentNav,
    currentNav: Number.isFinite(currentNav) ? currentNav : null,
    estimatedNav: Number.isFinite(estimatedNav) ? estimatedNav : null,
    cachedAt: new Date().toISOString(),
    officialDayGrowth: officialGrowth?.dayGrowthPct ?? null,
    officialDayGrowthDate: officialGrowth?.date ?? navDate
  };
}

export async function fetchBatchSnapshots(codes) {
  const normalizedCodes = normalizeFundCodes(codes, 50);
  const concurrency = 4;
  const snapshots = [];
  let index = 0;

  async function worker() {
    while (index < normalizedCodes.length) {
      const current = normalizedCodes[index++];
      const snapshot = await fetchFundSnapshot(current);
      snapshots.push(snapshot);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, normalizedCodes.length || 1) }, () => worker()));
  return normalizedCodes
    .map((code) => snapshots.find((snapshot) => snapshot.code === code))
    .filter(Boolean);
}

export async function fetchFundHistory(code) {
  const payload = await fetchPingZhongData(code);
  return {
    code: payload.code,
    name: payload.name,
    history: payload.history
  };
}

export async function fetchFundHoldings(code) {
  const normalizedCode = normalizeFundCode(code);
  if (!normalizedCode) throw new Error('Invalid fund code');

  const response = await upstreamFetch(
    `https://gushitong.baidu.com/opendata?resource_id=5803&query=${normalizedCode}&new_need_di=1&source=qieman`
  );
  if (!response.ok) throw new Error(`Holdings upstream failed: ${response.status}`);
  const payload = await response.json();

  const positionContent =
    payload?.Result?.[0]?.DisplayData?.resultData?.tplData?.result?.content?.tabs?.find((tab) => tab.type === 'position')
      ?.content;

  const rawHoldings = Array.isArray(positionContent?.heavyStock?.body) ? positionContent.heavyStock.body : [];
  const holdings = rawHoldings.map((item) => ({
    code: normalizeFundCode(item?.code),
    name: String(item?.name || '').trim(),
    ratio: Number(parsePercent(item?.positionProportion) ?? 0)
  })).filter((item) => item.code && item.name);

  const sectors = (Array.isArray(positionContent?.industryPositon?.list) ? positionContent.industryPositon.list : [])
    .map((item) => ({
      name: String(item?.text || '').trim(),
      weight: Number(parsePercent(item?.value) ?? 0)
    }))
    .filter((item) => item.name);

  const quotes = holdings.length === 0
    ? []
    : await fetchStockQuotes(holdings.map((holding) => holding.code));

  const quoteMap = new Map(quotes.map((item) => [item.code, item]));
  const mergedHoldings = holdings.map((holding) => {
    const quote = quoteMap.get(holding.code);
    return {
      ...holding,
      chg: quote?.chg ?? 0,
      industry: quote?.industry ?? ''
    };
  });

  const newest = extractBaiduNewest(findNewestNode(payload));

  return {
    code: normalizedCode,
    holdingDate: String(positionContent?.heavyStock?.titleHeader?.[1] || ''),
    holdings: mergedHoldings,
    sectors,
    top10Weight: Number(mergedHoldings.reduce((sum, item) => sum + (item.ratio || 0), 0).toFixed(2)),
    newest
  };
}

export async function fetchStockQuotes(codes) {
  const normalizedCodes = normalizeFundCodes(codes, 20);
  if (normalizedCodes.length === 0) return [];

  const secids = normalizedCodes
    .map((code) => (code.startsWith('6') ? `1.${code}` : `0.${code}`))
    .join(',');
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids}` +
    '&fields=f12,f3,f100&ut=fa5fd1943c7b386f172d6893dbfba10b';
  const response = await upstreamFetch(url);
  if (!response.ok) throw new Error(`Quote upstream failed: ${response.status}`);
  const payload = await response.json();
  const diff = Array.isArray(payload?.data?.diff) ? payload.data.diff : [];
  return diff
    .map((item) => ({
      code: normalizeFundCode(item?.f12),
      chg: Number(item?.f3),
      industry: String(item?.f100 || '').trim()
    }))
    .filter((item) => item.code && Number.isFinite(item.chg));
}

function parseTrendTime(str) {
  const text = String(str ?? '');
  const match = text.match(/(\d{2}:\d{2})/);
  return match ? match[1] : text;
}

function isAshareTradingTimeLabel(hhmm) {
  const match = String(hhmm ?? '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return true;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
}

export async function fetchMarketIndices(keys) {
  const selectedKeys = normalizeIndices(keys);
  const entries = await Promise.all(
    selectedKeys.map(async (key) => {
      const config = MARKET_INDICES[key];
      const url =
        `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${config.secid}` +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53';
      const response = await upstreamFetch(url);
      if (!response.ok) {
        throw new Error(`Index upstream failed: ${response.status}`);
      }
      const payload = await response.json();
      const trends = Array.isArray(payload?.data?.trends) ? payload.data.trends : [];
      const preClose = Number(payload?.data?.preClose);
      const times = [];
      const prices = [];
      for (const item of trends) {
        const [timeValue, priceValue] = String(item).split(',');
        const time = parseTrendTime(timeValue);
        if (config.type === 'cn' && !isAshareTradingTimeLabel(time)) continue;
        const price = Number.parseFloat(priceValue);
        if (!Number.isFinite(price)) continue;
        times.push(time);
        prices.push(price);
      }
      const lastPrice = prices[prices.length - 1];
      const changePct = Number.isFinite(lastPrice) && Number.isFinite(preClose) && preClose !== 0
        ? Number((((lastPrice - preClose) / preClose) * 100).toFixed(2))
        : null;
      return [
        key,
        {
          key,
          name: config.name,
          type: config.type,
          secid: config.secid,
          times,
          prices,
          preClose,
          lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
          changePct
        }
      ];
    })
  );

  return Object.fromEntries(entries);
}

function normalizeIndices(keys) {
  const requested = Array.isArray(keys) ? keys.filter((key) => key in MARKET_INDICES) : [];
  return requested.length > 0 ? requested : Object.keys(MARKET_INDICES);
}

export function getMarketIndexConfig() {
  return MARKET_INDICES;
}
