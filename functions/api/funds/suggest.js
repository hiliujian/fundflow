import { errorResponse, jsonResponse, methodNotAllowed, readThroughCache } from '../../_shared/http.js';
import { fetchFundSuggest } from '../../_shared/upstream.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return methodNotAllowed();
  }

  const url = new URL(context.request.url);
  const keyword = String(url.searchParams.get('keyword') || '').trim();
  if (!keyword) {
    return errorResponse(400, 'Missing keyword');
  }

  return readThroughCache(context, `/api/funds/suggest/${encodeURIComponent(keyword)}`, 600, async () => {
    const items = await fetchFundSuggest(keyword);
    return jsonResponse({ keyword, items }, {}, { cacheControl: 'public, max-age=600, s-maxage=600' });
  });
}
