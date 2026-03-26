import { errorResponse, jsonResponse, methodNotAllowed, normalizeFundCode, readThroughCache } from '../../_shared/http.js';
import { fetchFundHistory } from '../../_shared/upstream.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed();
  }

  const url = new URL(context.request.url);
  const code = normalizeFundCode(url.searchParams.get('code'));
  if (!code) {
    return errorResponse(400, 'Missing or invalid fund code');
  }

  return readThroughCache(context, `/api/funds/history/${code}`, 3600, async () => {
    const history = await fetchFundHistory(code);
    return jsonResponse(history, {}, { cacheControl: 'public, max-age=3600, s-maxage=3600' });
  });
}
