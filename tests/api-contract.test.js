import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFundCode,
  normalizeFundCodes,
  toDayGrowthResponse,
  withSecurityHeaders
} from '../functions/_shared/http.js';

test('normalizeFundCode extracts six-digit code from prefixes', () => {
  assert.equal(normalizeFundCode('sh501018'), '501018');
  assert.equal(normalizeFundCode('  003095  '), '003095');
  assert.equal(normalizeFundCode('abc'), null);
});

test('normalizeFundCodes deduplicates and preserves valid order', () => {
  assert.deepEqual(
    normalizeFundCodes(['001632', 'sh501018', '001632', 'bad', ' 003095 ']),
    ['001632', '501018', '003095']
  );
});

test('toDayGrowthResponse keeps only n8n-safe fields', () => {
  const payload = toDayGrowthResponse({
    code: '001632',
    date: '2026-03-26',
    dayGrowthPct: 1.23,
    source: 'fundgz_json',
    nav: 1.2345,
    cachedAt: '2026-03-26T09:30:00.000Z',
    estimatedNav: 1.25
  });

  assert.deepEqual(payload, {
    code: '001632',
    date: '2026-03-26',
    dayGrowthPct: 1.23,
    source: 'fundgz_json',
    nav: 1.2345,
    cachedAt: '2026-03-26T09:30:00.000Z'
  });
});

test('withSecurityHeaders appends hardening headers and cache policy', () => {
  const response = withSecurityHeaders(
    new Response('{}', {
      headers: {
        'content-type': 'application/json'
      }
    }),
    {
      cacheControl: 'public, max-age=60'
    }
  );

  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
});
