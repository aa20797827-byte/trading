/**
 * Cloudflare Pages Function
 * GET /api/extended-price?ticker=RDW
 *
 * Nasdaq 프리/애프터장 실시간 가격을 CORS 없이 반환
 * - 프리장:   4:00 AM ~ 9:30 AM ET
 * - 애프터장: 4:00 PM ~ 8:00 PM ET
 */

export async function onRequest(context) {
  // OPTIONS preflight
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

  // "$24.36 +6.87 (+39.28%)" 형식에서 가격 파싱
  const parsePrice = (str) => {
    if (!str || str === 'N/A') return null;
    const m = str.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    return m ? parseFloat(m[1]) : null;
  };

  // "(+39.28%)" 형식에서 등락률 파싱
  const parsePct = (str) => {
    if (!str) return null;
    const m = str.match(/\(([+-]?[0-9]+(?:\.[0-9]+)?)%\)/);
    return m ? parseFloat(m[1]) : null;
  };

  try {
    const [preRes, postRes] = await Promise.all([
      fetch(
        `https://api.nasdaq.com/api/quote/${ticker}/extended-trading?assetclass=stocks&markettype=pre`,
        { headers: nasdaqHeaders }
      ),
      fetch(
        `https://api.nasdaq.com/api/quote/${ticker}/extended-trading?assetclass=stocks&markettype=post`,
        { headers: nasdaqHeaders }
      ),
    ]);

    const [preData, postData] = await Promise.all([
      preRes.json().catch(() => null),
      postRes.json().catch(() => null),
    ]);

    const preRow  = preData?.data?.infoTable?.rows?.[0]  || null;
    const postRow = postData?.data?.infoTable?.rows?.[0] || null;

    const result = {
      ticker,
      pre: preRow ? {
        price:  parsePrice(preRow.consolidated),
        pct:    parsePct(preRow.consolidated),
        high:   parsePrice(preRow.highPrice),
        low:    parsePrice(preRow.lowPrice),
        volume: preRow.volume || null,
        raw:    preRow.consolidated,
      } : null,
      post: postRow ? {
        price:  parsePrice(postRow.consolidated),
        pct:    parsePct(postRow.consolidated),
        high:   parsePrice(postRow.highPrice),
        low:    parsePrice(postRow.lowPrice),
        volume: postRow.volume || null,
        raw:    postRow.consolidated,
      } : null,
      // 프리/애프터 중 더 최신 데이터 (unified용)
      extended: null,
    };

    // unified: 현재 상태에 맞는 가격 선택
    if (result.pre?.price)  result.extended = result.pre;
    if (result.post?.price) result.extended = result.post;

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
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}
