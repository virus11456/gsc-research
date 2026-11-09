import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createServiceAccountJwt, filterAndSortQueries, matchQuery, renderMarkdown, tokenize } from '../lib.mjs';

test('filters rows by thresholds and brand terms', () => {
  const rows = [
    { keys: ['valid query'], impressions: 5, position: 8, ctr: 0.1 },
    { keys: ['low impressions'], impressions: 4, position: 12 },
    { keys: ['high rank'], impressions: 20, position: 7.9 },
    { keys: ['x'], impressions: 30, position: 9 },
    { keys: ['Lux Stay luxstay deal'], impressions: 30, position: 9 },
    { keys: ['BAOCHE-KING review'], impressions: 30, position: 9 },
  ];
  assert.deepEqual(filterAndSortQueries(rows).map((r) => r.query), ['valid query']);
});

test('sorts by opportunity score descending and limits results', () => {
  const rows = [
    { keys: ['alpha'], impressions: 10, position: 20 },
    { keys: ['beta'], impressions: 8, position: 10 },
    { keys: ['gamma'], impressions: 20, position: 30 },
  ];
  assert.deepEqual(filterAndSortQueries(rows, 2).map((r) => r.query), ['gamma', 'beta']);
});

test('tokenizes allowed scripts, removes stop words and singularizes English plurals', () => {
  assert.deepEqual(tokenize('Best Hotels & luxury-tips 台灣 包車 日本! cats bus'), ['hotel', '台灣', '日本', 'cat', 'bus']);
});

test('deduplicates query tokens', () => {
  assert.deepEqual(tokenize('hotel hotel hotels'), ['hotel']);
});

test('classifies a 70 percent overlap as REFRESH and records the post', () => {
  const post = { slug: 'airport-transfer-hotel-tour', title: 'Airport transfer hotel tour', link: 'https://example.com/post' };
  const result = matchQuery('airport transfer hotel price', [post]);
  assert.equal(result.type, 'REFRESH');
  assert.equal(result.ratio, 0.75);
  assert.equal(result.post, post);
});

test('classifies low overlap and stop-word-only queries as NEW', () => {
  assert.equal(matchQuery('airport transfer price', [{ slug: 'airport-guide', title: 'Airport Guide' }]).type, 'NEW');
  assert.deepEqual(matchQuery('best guide', []), { type: 'NEW', ratio: 0, post: null });
});

test('signs a verifiable RS256 JWT with the read-only scope', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createServiceAccountJwt({ client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 0);
  const [h, c, s] = jwt.split('.');
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).scope, 'https://www.googleapis.com/auth/webmasters.readonly');
});

test('renders NEW and REFRESH tables', () => {
  const md = renderMarkdown('funday', [
    { query: 'a|b', impressions: 9, position: 12, ctr: 0.01, match: { type: 'NEW', ratio: 0 } },
    { query: 'tokyo trip', impressions: 6, position: 9, ctr: 0, match: { type: 'REFRESH', ratio: 1, post: { title: 'Tokyo', link: 'https://x/t' } } },
  ], new Date('2026-11-09T00:00:00Z'));
  assert.match(md, /^# GSC Opportunities — funday — 2026-11-09/);
  assert.match(md, /\| 1 \| a\\\|b \| 9 \| 12\.0 \| 1\.0% \|/);
  assert.match(md, /\[Tokyo\]\(https:\/\/x\/t\) \| 100% \| 9\.0 \| 6 \|/);
});
