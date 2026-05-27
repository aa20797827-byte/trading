/**
 * Cloudflare Pages Function
 * GET /api/extended-price?ticker=RDW
 *
 * 1순위: Nasdaq /info secondaryData  — 프리/애프터 활성 중 실시간 가격
 * 2순위: Nasdaq /extended-trading    — 마감 후 마지막 세션 데이터
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

  const nasdaqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nasdaq.com/',
    'Origin': 'https://www.nasdaq.com',
  };

  const parsePrice = (str) => {
    if (!str || str === 'N/A') return null;
    const m = str.replace(/,/g, '').match(/\$?([0-9]+(?:\.[0-9]+)?)/);
    return m ? parseFloat(m[1]) : null;
  };

  const parsePct = (str) => {
    if (!str) return null;
    // "(+39.28%)" 또는 "+39.28%" 또는 "39.28%"
    const m = str.match(/([+-]?[0-9]+(?:\.[0-9]+)?)%/);
    return m ? parseFloat(m[1]) : null;
  };

  try {
    // 3개 엔드포인트 병렬 호출
    const [infoRes, preRes, postRes] = await Promise.all([
      fetch(`https://api.nasdaq.com/api/quote/${ticker}/info?assetclass=stocks`, { headers: nasdaqHeaders }),
      fetch(`https://api.nasdaq.com/api/quote/${ticker}/extended-trading?assetclass=stocks&markettype=pre`, { headers: nasdaqHeaders }),
      fetch(`https://api.nasdaq.com/api/quote/${ticker}/extended-trading?assetclass=stocks&markettype=post`, { headers: nasdaqHeaders }),
    ]);

    const [infoData, preData, postData] = await Promise.all([
      infoRes.json().catch(() => null),
      preRes.json().catch(() => null),
      postRes.json().catch(() => null),
    ]);

    // ── 1순위: secondaryData (프리/애프터 활성 중 실시간) ──
    const secondary = infoData?.data?.secondaryData;
    const primary   = infoData?.data?.primaryData;
    const mktStatus = infoData?.data?.marketStatus || 'Closed';

    let live = null;
    if (secondary?.lastSalePrice) {
      const livePrice = parsePrice(secondary.lastSalePrice);
      const livePct   = parsePct(secondary.percentageChange);
      if (livePrice && livePrice > 0) {
        live = {
          price:     livePrice,
          pct:       livePct,
          change:    parsePrice(secondary.netChange),
          timestamp: secondary.lastTradeTimestamp,
          type:      secondary.type || mktStatus, // "PRE_MARKET" | "AFTER_HOURS"
        };
      }
    }

    // ── 정규장 마지막 가격 ──
    let regularPrice = null, regularPct = null, regularChgAbs = null;
    if (primary?.lastSalePrice) {
      regularPrice  = parsePrice(primary.lastSalePrice);
      regularPct    = parsePct(primary.percentageChange);
      regularChgAbs = parsePrice(primary.netChange);
    }

    // ── 2순위: 세션 집계 데이터 ──
    const preRow  = preData?.data?.infoTable?.rows?.[0]  || null;
    const postRow = postData?.data?.infoTable?.rows?.[0] || null;

    const result = {
      ticker,
      marketStatus: mktStatus,
      live,           // 활성 프리/애프터 실시간 (null이면 비활성)
      regular: regularPrice ? {
        price: regularPrice,
        pct:   regularPct,
        chg:   regularChgAbs,
      } : null,
      pre: preRow ? {
        price:  parsePrice(preRow.consolidated),
        pct:    parsePct(preRow.consolidated),
        high:   parsePrice(preRow.highPrice),
        low:    parsePrice(preRow.lowPrice),
        volume: preRow.volume || null,
      } : null,
      post: postRow ? {
        price:  parsePrice(postRow.consolidated),
        pct:    parsePct(postRow.consolidated),
        high:   parsePrice(postRow.highPrice),
        low:    parsePrice(postRow.lowPrice),
        volume: postRow.volume || null,
      } : null,
    };

    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), ticker }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
}
