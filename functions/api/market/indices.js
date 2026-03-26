import { jsonResponse, methodNotAllowed, readQueryArray, readThroughCache } from '../../_shared/http.js';
import { fetchMarketIndices } from '../../_shared/upstream.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed();
  }

  const url = new URL(context.request.url);
  const keys = readQueryArray(url, 'keys');

  return readThroughCache(context, `/api/market/indices/${keys.join(',') || 'all'}`, 30, async () => {
    const items = await fetchMarketIndices(keys);
    return jsonResponse(
      {
        items,
        cachedAt: new Date().toISOString()
      },
      {},
      { cacheControl: 'public, max-age=30, s-maxage=30' }
    );
  });
}
