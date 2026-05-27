/**
 * Cloudflare Pages Function
 * GET /api/extended-price?ticker=AAPL
 *
 * 1순위: Yahoo Finance v7 quote  — preMarketPrice / postMarketPrice 실시간
 * 2순위: Yahoo Finance v8 chart  — v7 실패 시 chart data에서 추출
 * 3순위: Nasdaq API              — 최후 fallback
 */

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const { searchParams } = new URL(context.request.url);
  const ticker = (searchParams.get('ticker') || 'AAPL').toUpperCase().trim();

  const RESP_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  // ── 공통 파서 ──
  const num = (v) => {
    if (v == null || v === '' || v === 'N/A') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,$]/g, ''));
    return isNaN(n) ? null : n;
  };

  const pctStr = (str) => {
    if (!str) return null;
    const m = String(str).match(/([+-]?[0-9]+(?:\.[0-9]+)?)%/);
    return m ? parseFloat(m[1]) : null;
  };

  // ══════════════════════════════════════════════════════
  // 1순위: Yahoo Finance v7 quote
  // → preMarketPrice, preMarketChangePercent 등을 직접 반환
  // ══════════════════════════════════════════════════════
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);

    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}` +
      `&fields=preMarketPrice,preMarketChange,preMarketChangePercent` +
      `,postMarketPrice,postMarketChange,postMarketChangePercent` +
      `,regularMarketPrice,regularMarketChange,regularMarketChangePercent` +
      `,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,marketState`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://finance.yahoo.com',
          'Referer': 'https://finance.yahoo.com/',
        },
        signal: ctrl.signal,
      }
    );

    if (r.ok) {
      const data = await r.json();
      const q = data?.quoteResponse?.result?.[0];

      if (q?.regularMarketPrice) {
        const state = (q.marketState || 'CLOSED').toUpperCase();
        const isPre  = state === 'PRE'  || state === 'PREPRE';
        const isPost = state === 'POST' || state === 'POSTPOST';

        const regularPrice  = num(q.regularMarketPrice);
        // Yahoo v7: 퍼센트는 이미 % 단위 (e.g. 1.23 = +1.23%)
        const regularPct    = num(q.regularMarketChangePercent);
        const regularChgAbs = num(q.regularMarketChange);
        const prevClose     = num(q.regularMarketPreviousClose);
        const dayHigh       = num(q.regularMarketDayHigh);
        const dayLow        = num(q.regularMarketDayLow);

        const prePrice   = num(q.preMarketPrice);
        const prePct     = num(q.preMarketChangePercent);
        const preChgAbs  = num(q.preMarketChange);

        const postPrice  = num(q.postMarketPrice);
        const postPct    = num(q.postMarketChangePercent);
        const postChgAbs = num(q.postMarketChange);

        // 현재 활성 세션 → live
        let live = null;
        if (isPre  && prePrice)  live = { price: prePrice,  pct: prePct,  change: preChgAbs,  type: 'PRE_MARKET'  };
        if (isPost && postPrice) live = { price: postPrice, pct: postPct, change: postChgAbs, type: 'AFTER_HOURS' };

        return new Response(JSON.stringify({
          ticker, marketStatus: state, source: 'yahoo',
          live,
          regular: regularPrice ? { price: regularPrice, pct: regularPct, chg: regularChgAbs } : null,
          pre:  prePrice  ? { price: prePrice,  pct: prePct,  chg: preChgAbs  } : null,
          post: postPrice ? { price: postPrice, pct: postPct, chg: postChgAbs } : null,
          dayHigh, dayLow, prevClose,
        }), { headers: RESP_HEADERS });
      }
    }
  } catch (_) { /* → v8 fallback */ }

  // ══════════════════════════════════════════════════════
  // 2순위: Yahoo Finance v8 chart (includePrePost=true)
  // → meta에서 가격 추출, chart 마지막 캔들로 extended price 파악
  // ══════════════════════════════════════════════════════
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);

    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      }
    );

    if (r.ok) {
      const data = await r.json();
      const res  = data?.chart?.result?.[0];
      const meta = res?.meta;

      if (meta?.regularMarketPrice) {
        const regularPrice = num(meta.regularMarketPrice);
        const prevClose    = num(meta.previousClose ?? meta.chartPreviousClose);
        const dayHigh      = num(meta.regularMarketDayHigh);
        const dayLow       = num(meta.regularMarketDayLow);

        // 마지막 유효 캔들
        const timestamps = res?.timestamp || [];
        const closes     = res?.indicators?.quote?.[0]?.close || [];
        let lastPrice = null, lastTs = null;
        for (let i = closes.length - 1; i >= 0; i--) {
          if (closes[i] != null) { lastPrice = closes[i]; lastTs = timestamps[i]; break; }
        }

        // 현재 세션 판단
        const now = Math.floor(Date.now() / 1000);
        const tp  = meta.currentTradingPeriod;
        let state = 'CLOSED';
        if      (tp?.pre     && now >= tp.pre.start     && now < tp.pre.end)     state = 'PRE';
        else if (tp?.regular && now >= tp.regular.start && now < tp.regular.end) state = 'REGULAR';
        else if (tp?.post    && now >= tp.post.start    && now < tp.post.end)    state = 'POST';

        const isPre  = state === 'PRE';
        const isPost = state === 'POST';

        let prePrice = null, prePct = null, preChgAbs = null;
        let postPrice = null, postPct = null, postChgAbs = null;

        if (isPre && lastPrice && lastPrice !== regularPrice) {
          prePrice  = lastPrice;
          preChgAbs = prevClose ? lastPrice - prevClose : null;
          prePct    = prevClose && preChgAbs != null ? (preChgAbs / prevClose) * 100 : null;
        } else if (isPost && lastPrice && lastPrice !== regularPrice) {
          postPrice  = lastPrice;
          postChgAbs = regularPrice ? lastPrice - regularPrice : null;
          postPct    = regularPrice && postChgAbs != null ? (postChgAbs / regularPrice) * 100 : null;
        }

        const regChgAbs = prevClose && regularPrice ? regularPrice - prevClose : null;
        const regPct    = prevClose && regChgAbs != null ? (regChgAbs / prevClose) * 100 : 0;

        let live = null;
        if (isPre  && prePrice)  live = { price: prePrice,  pct: prePct,  change: preChgAbs,  type: 'PRE_MARKET'  };
        if (isPost && postPrice) live = { price: postPrice, pct: postPct, change: postChgAbs, type: 'AFTER_HOURS' };

        return new Response(JSON.stringify({
          ticker, marketStatus: state, source: 'yahoo_chart',
          live,
          regular: regularPrice ? { price: regularPrice, pct: regPct, chg: regChgAbs } : null,
          pre:  prePrice  ? { price: prePrice,  pct: prePct,  chg: preChgAbs  } : null,
          post: postPrice ? { price: postPrice, pct: postPct, chg: postChgAbs } : null,
          dayHigh, dayLow, prevClose,
        }), { headers: RESP_HEADERS });
      }
    }
  } catch (_) { /* → Nasdaq fallback */ }

  // ══════════════════════════════════════════════════════
  // 3순위: Nasdaq API (최후 fallback)
  // ══════════════════════════════════════════════════════
  const nasdaqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nasdaq.com/',
    'Origin': 'https://www.nasdaq.com',
  };

  try {
    const [infoRes, preRes, postRes] = await Promise.all([
      fetch(`https://api.nasdaq.com/api/quote/${ticker}/info?assetclass=stocks`,                                           { headers: nasdaqHeaders }),
      fetch(`https://api.nasdaq.com/api/quote/${ticker}/extended-trading?assetclass=stocks&markettype=pre`,  { headers: nasdaqHeaders }),
      fetch(`https://api.nasdaq.com/api/quote/${ticker}/extended-trading?assetclass=stocks&markettype=post`, { headers: nasdaqHeaders }),
    ]);

    const [infoData, preData, postData] = await Promise.all([
      infoRes.json().catch(() => null),
      preRes.json().catch(() => null),
      postRes.json().catch(() => null),
    ]);

    const secondary = infoData?.data?.secondaryData;
    const primary   = infoData?.data?.primaryData;
    const mktStatus = infoData?.data?.marketStatus || 'Closed';

    let live = null;
    if (secondary?.lastSalePrice) {
      const livePrice = num(secondary.lastSalePrice.replace(/[$,]/g, ''));
      const livePct   = pctStr(secondary.percentageChange);
      if (livePrice && livePrice > 0) {
        live = {
          price: livePrice, pct: livePct,
          change: num((secondary.netChange || '').replace(/[$,]/g, '')),
          timestamp: secondary.lastTradeTimestamp,
          type: secondary.type || mktStatus,
        };
      }
    }

    let regularPrice = null, regularPct = null, regularChgAbs = null;
    if (primary?.lastSalePrice) {
      regularPrice  = num(primary.lastSalePrice.replace(/[$,]/g, ''));
      regularPct    = pctStr(primary.percentageChange);
      regularChgAbs = num((primary.netChange || '').replace(/[$,]/g, ''));
    }

    const preRow  = preData?.data?.infoTable?.rows?.[0]  || null;
    const postRow = postData?.data?.infoTable?.rows?.[0] || null;

    const parseRowPrice = (s) => {
      if (!s || s === 'N/A') return null;
      return num(s.replace(/[$,]/g, ''));
    };

    return new Response(JSON.stringify({
      ticker, marketStatus: mktStatus, source: 'nasdaq',
      live,
      regular: regularPrice ? { price: regularPrice, pct: regularPct, chg: regularChgAbs } : null,
      pre: preRow ? {
        price:  parseRowPrice(preRow.consolidated),
        pct:    pctStr(preRow.percentageChange ?? preRow.netChange),
        chg:    parseRowPrice(preRow.netChange),
        high:   parseRowPrice(preRow.highPrice),
        low:    parseRowPrice(preRow.lowPrice),
        volume: preRow.volume || null,
      } : null,
      post: postRow ? {
        price:  parseRowPrice(postRow.consolidated),
        pct:    pctStr(postRow.percentageChange ?? postRow.netChange),
        chg:    parseRowPrice(postRow.netChange),
        high:   parseRowPrice(postRow.highPrice),
        low:    parseRowPrice(postRow.lowPrice),
        volume: postRow.volume || null,
      } : null,
    }), { headers: RESP_HEADERS });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), ticker }),
      { status: 500, headers: RESP_HEADERS }
    );
  }
}
