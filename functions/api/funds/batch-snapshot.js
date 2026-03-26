import { errorResponse, jsonResponse, methodNotAllowed, normalizeFundCodes, readQueryArray, readThroughCache } from '../../_shared/http.js';
import { fetchBatchSnapshots } from '../../_shared/upstream.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed();
  }

  const url = new URL(context.request.url);
  const codes = normalizeFundCodes(readQueryArray(url, 'codes'));
  if (codes.length === 0) {
    return errorResponse(400, 'Missing or invalid fund codes');
  }

  return readThroughCache(context, `/api/funds/batch-snapshot/${codes.join(',')}`, 45, async () => {
    const items = await fetchBatchSnapshots(codes);
    return jsonResponse(
      {
        codes,
        items,
        cachedAt: new Date().toISOString()
      },
      {},
      { cacheControl: 'public, max-age=45, s-maxage=45' }
    );
  });
}
