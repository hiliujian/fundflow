import { errorResponse, jsonResponse, methodNotAllowed, normalizeFundCode, readThroughCache } from '../../_shared/http.js';
import { fetchFundHoldings } from '../../_shared/upstream.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed();
  }

  const url = new URL(context.request.url);
  const code = normalizeFundCode(url.searchParams.get('code'));
  if (!code) {
    return errorResponse(400, 'Missing or invalid fund code');
  }

  return readThroughCache(context, `/api/funds/holdings/${code}`, 300, async () => {
    const holdings = await fetchFundHoldings(code);
    return jsonResponse(holdings, {}, { cacheControl: 'public, max-age=300, s-maxage=300' });
  });
}
