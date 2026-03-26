const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

export function normalizeFundCode(value) {
  const match = String(value ?? '').match(/\d{6}/);
  return match ? match[0] : null;
}

export function normalizeFundCodes(values, limit = 50) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const code = normalizeFundCode(value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= limit) break;
  }
  return out;
}

export function toDayGrowthResponse(snapshot) {
  return {
    code: snapshot.code,
    date: snapshot.date,
    dayGrowthPct: snapshot.dayGrowthPct,
    source: snapshot.source,
    nav: snapshot.nav,
    cachedAt: snapshot.cachedAt
  };
}

export function withSecurityHeaders(response, options = {}) {
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', DEFAULT_CSP);
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (options.cacheControl) {
    headers.set('cache-control', options.cacheControl);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function jsonResponse(payload, init = {}, options = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return withSecurityHeaders(
    new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      statusText: init.statusText,
      headers
    }),
    options
  );
}

export function errorResponse(status, message, details) {
  return jsonResponse(
    {
      error: {
        message,
        ...(details ? { details } : {})
      }
    },
    { status },
    { cacheControl: 'no-store' }
  );
}

export function methodNotAllowed(allow = 'GET') {
  return errorResponse(405, 'Method not allowed', { allow });
}

export function readQueryArray(url, name) {
  return url.searchParams
    .get(name)
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

export async function readThroughCache(context, cacheKey, ttlSeconds, factory) {
  const cache = globalThis.caches?.default;
  if (!cache) {
    return factory();
  }

  const keyUrl = new URL(context.request.url);
  keyUrl.pathname = `/__edge-cache${cacheKey}`;
  keyUrl.search = '';

  const cacheRequest = new Request(keyUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheRequest);
  if (cached) {
    return cached;
  }

  const response = await factory();
  if (response.ok) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set('cache-control', `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`);
    const putPromise = cache.put(cacheRequest, cachedResponse.clone());
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(putPromise);
    } else {
      await putPromise;
    }
    return cachedResponse;
  }

  return response;
}
