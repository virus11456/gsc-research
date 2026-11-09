import { createSign } from 'node:crypto';

export const SITE_CONFIG = Object.freeze({
  elnido: {
    property: 'https://www.elnidohotelsranking.com/',
    postsEndpoint: 'https://www.elnidohotelsranking.com/wp-json/wp/v2/posts',
    output: 'elnido-latest.md',
  },
  funday: {
    property: 'https://baocheking.com/',
    postsEndpoint: 'https://baocheking.com/wp-json/wp/v2/guide',
    output: 'funday-latest.md',
  },
  luxstay: {
    property: 'https://luxstay.world/',
    postsEndpoint: 'https://luxstay.world/wp-json/wp/v2/posts',
    output: 'luxstay-latest.md',
  },
});

export const STOP_WORDS = new Set(`
  2026 2025 guide tips tip best ultimate the a an how to in of for with and or vs vs.
  what is de au le la les du des el nido palawan luxury luxstay luxstays
  baocheking funday 包車 攻略
`.trim().split(/\s+/));

const BRAND_TERMS = ['luxstay', 'elnidohotelsranking', 'funday', 'baocheking'];

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createServiceAccountJwt(credentials, now = Date.now()) {
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Service Account JSON 缺少 client_email 或 private_key');
  }
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(credentials.private_key, 'base64url')}`;
}

export function filterAndSortQueries(rows, limit = 30) {
  return rows
    .map((row) => ({
      ...row,
      query: String(row.keys?.[0] ?? row.query ?? '').trim(),
      impressions: Number(row.impressions ?? 0),
      position: Number(row.position ?? 0),
      ctr: Number(row.ctr ?? 0),
    }))
    .filter((row) => row.impressions >= 5 && row.position >= 8 && [...row.query].length >= 2)
    .filter((row) => {
      const normalized = row.query.toLowerCase().replace(/[\s._-]+/g, '');
      return !BRAND_TERMS.some((brand) => normalized.includes(brand));
    })
    .map((row) => ({ ...row, score: row.impressions * (1 + Math.max(0, 20 - row.position) / 10) }))
    .sort((a, b) => b.score - a.score || b.impressions - a.impressions || a.query.localeCompare(b.query))
    .slice(0, limit);
}

// 中日韓字沒有空格：連續字串切成相鄰兩字（bigram）；通用詞的 bigram 不列入比對
export const CJK_STOP_BIGRAMS = new Set([
  '包車', '攻略', '推薦', '景點', '自由', '由行', '一日', '日遊', '價格', '費用',
]);
export const MATCH_THRESHOLDS = Object.freeze({ cjk: 0.6, latin: 0.7 });
const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
const CJK_PATTERN = new RegExp(`[${CJK}]`, 'u');
const SEGMENT_PATTERN = new RegExp(`[${CJK}]+|[a-z0-9]+(?:\\.[a-z0-9]+)*`, 'gu');

export function tokenize(value) {
  const tokens = [];
  for (const segment of String(value ?? '').toLowerCase().match(SEGMENT_PATTERN) ?? []) {
    if (CJK_PATTERN.test(segment)) {
      const chars = [...segment];
      if (chars.length === 1) continue;
      for (let i = 0; i < chars.length - 1; i += 1) {
        const bigram = chars[i] + chars[i + 1];
        if (!CJK_STOP_BIGRAMS.has(bigram) && !STOP_WORDS.has(bigram)) tokens.push(bigram);
      }
    } else {
      const token = segment.endsWith('s') && segment.length > 3 ? segment.slice(0, -1) : segment;
      if (token.length > 1 && !STOP_WORDS.has(token)) tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

function decodeSlug(slug) {
  try { return decodeURIComponent(String(slug ?? '')); } catch { return String(slug ?? ''); }
}

export function matchQuery(query, posts, threshold) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { type: 'NEW', ratio: 0, post: null };
  const limit = threshold ?? (CJK_PATTERN.test(String(query ?? '')) ? MATCH_THRESHOLDS.cjk : MATCH_THRESHOLDS.latin);
  let best = { ratio: 0, post: null };
  for (const post of posts) {
    const postTokens = new Set(tokenize(`${decodeSlug(post.slug)} ${stripHtml(post.title)}`));
    const matched = queryTokens.filter((token) => postTokens.has(token)).length;
    const ratio = matched / queryTokens.length;
    if (ratio > best.ratio) best = { ratio, post };
  }
  return best.ratio >= limit ? { type: 'REFRESH', ...best } : { type: 'NEW', ...best };
}

export function classifyQueries(rows, posts) {
  return rows.map((row) => ({ ...row, match: matchQuery(row.query, posts) }));
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function postLink(post) {
  const label = escapeCell(post?.title || post?.slug || post?.link || 'Existing post');
  return post?.link ? `[${label}](${post.link})` : label;
}

export function renderMarkdown(site, classified, generatedAt = new Date()) {
  const taipei = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(generatedAt).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const date = `${taipei.year}-${taipei.month}-${taipei.day}`;
  const time = `${taipei.hour}:${taipei.minute}`;
  const fresh = classified.filter((row) => row.match.type === 'NEW');
  const refresh = classified.filter((row) => row.match.type === 'REFRESH');
  return [
    `# GSC Opportunities — ${site} — ${date}`,
    '',
    `Generated at ${date} ${time} (Taipei).`,
    '',
    '## NEW candidates (verified no existing article via strict token matching)',
    '',
    '| # | Query | Impressions | Position | CTR | Match check |',
    '|---:|---|---:|---:|---:|---|',
    ...fresh.map((row, i) => `| ${i + 1} | ${escapeCell(row.query)} | ${row.impressions} | ${row.position.toFixed(1)} | ${(row.ctr * 100).toFixed(1)}% | No match (best ${(row.match.ratio * 100).toFixed(0)}%) |`),
    '',
    '## REFRESH candidates (existing article to expand)',
    '',
    '| # | Query | Existing post | Match ratio | Position | Impressions |',
    '|---:|---|---|---:|---:|---:|',
    ...refresh.map((row, i) => `| ${i + 1} | ${escapeCell(row.query)} | ${postLink(row.match.post)} | ${(row.match.ratio * 100).toFixed(0)}% | ${row.position.toFixed(1)} | ${row.impressions} |`),
    '',
  ].join('\n');
}

export function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
