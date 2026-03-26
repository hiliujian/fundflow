import { errorResponse, jsonResponse, methodNotAllowed, normalizeFundCode, readThroughCache, toDayGrowthResponse } from '../../_shared/http.js';
import { fetchFundSnapshot } from '../../_shared/upstream.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed();
  }

  const url = new URL(context.request.url);
  const code = normalizeFundCode(url.searchParams.get('code'));
  if (!code) {
    return errorResponse(400, 'Missing or invalid fund code');
  }

  return readThroughCache(context, `/api/funds/day-growth/${code}`, 45, async () => {
    const snapshot = await fetchFundSnapshot(code);
    return jsonResponse(toDayGrowthResponse(snapshot), {}, { cacheControl: 'public, max-age=45, s-maxage=45' });
  });
}
