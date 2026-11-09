#!/usr/bin/env node
// 每日 GSC 關鍵字機會：GSC API 抓 28 天 query → 篩選排序 → 比對全站文章 → 寫 <site>-latest.md
// stdout 最後一行是 JSON 摘要（OpenClaw 解析用）；金鑰內容絕不輸出
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  SITE_CONFIG, classifyQueries, createServiceAccountJwt, filterAndSortQueries,
  renderMarkdown, stripHtml,
} from './lib.mjs';

function parseArgs(argv) {
  let site = 'all';
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--site') { site = argv[i + 1]; i += 1; }
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`未知參數：${arg}`);
  }
  if (![...Object.keys(SITE_CONFIG), 'all'].includes(site)) {
    throw new Error(`--site 必須是 funday、elnido、luxstay 或 all（收到 ${site || '空值'}）`);
  }
  return { site, dryRun };
}

const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const taipeiDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const formatDate = (d) => d.toISOString().slice(0, 10);

function searchDateRange(now = new Date()) {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

async function fetchJson(url, options = {}, label = String(url)) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  let json;
  try { json = body ? JSON.parse(body) : null; } catch { json = null; }
  if (!response.ok) {
    const detail = json?.error?.message || json?.message || body.slice(0, 300) || response.statusText;
    throw new Error(`${label} 失敗（HTTP ${response.status}）：${detail}`);
  }
  return json;
}

async function getAccessToken(credentials) {
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: createServiceAccountJwt(credentials),
  });
  const result = await fetchJson(tokenUri, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  }, 'Google OAuth');
  if (!result?.access_token) throw new Error('Google OAuth 回應未包含 access_token');
  return result.access_token;
}

async function fetchQueries(config, accessToken) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(config.property)}/searchAnalytics/query`;
  const result = await fetchJson(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...searchDateRange(), dimensions: ['query'], rowLimit: 500 }),
  }, `GSC ${config.property}`);
  return result?.rows ?? [];
}

async function fetchPosts(config) {
  const posts = [];
  for (let page = 1; page <= 30; page += 1) {
    const url = new URL(config.postsEndpoint);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('_fields', 'id,slug,title,link');
    url.searchParams.set('status', 'publish');
    let batch;
    try {
      batch = await fetchJson(url, {}, `WordPress ${url.hostname} page ${page}`);
    } catch (error) {
      // WP 超過最後一頁回 400（rest_post_invalid_page_number）
      if (/HTTP 400/.test(error.message) && page > 1) break;
      throw error;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch.map((post) => ({
      id: post.id,
      slug: post.slug || '',
      title: stripHtml(post.title?.rendered ?? post.title ?? ''),
      link: post.link || '',
    })));
    if (batch.length < 100) break;
  }
  return posts;
}

async function readCredentials(keyPath) {
  try {
    return JSON.parse(await readFile(keyPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`找不到 GSC Service Account 金鑰：${keyPath}。請將 JSON 放在此路徑，或設定 GSC_SA_KEY。`);
    if (error instanceof SyntaxError) throw new Error(`GSC Service Account JSON 格式錯誤：${keyPath}`);
    throw new Error(`無法讀取 GSC Service Account 金鑰 ${keyPath}：${error.code || 'unknown error'}`);
  }
}

async function main() {
  const summary = { date: taipeiDate(), sites: {}, warnings: [] };
  let failed = false;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node tools/gsc-research/run.mjs [--site funday|elnido|luxstay|all] [--dry-run]');
      return;
    }
    const selected = args.site === 'all' ? Object.keys(SITE_CONFIG) : [args.site];
    const keyPath = resolve(expandHome(process.env.GSC_SA_KEY || '~/.config/gsc/service-account.json'));
    const outputDir = resolve(expandHome(process.env.GSC_SHARED || '~/Documents/gsc-shared/'));
    let accessToken;
    try {
      accessToken = await getAccessToken(await readCredentials(keyPath));
    } catch (error) {
      console.error(error.message);
      summary.warnings.push(error.message);
      for (const site of selected) summary.sites[site] = { error: error.message };
      process.exitCode = 1;
      console.log(JSON.stringify(summary));
      return;
    }
    for (const site of selected) {
      const config = SITE_CONFIG[site];
      try {
        const [rows, posts] = await Promise.all([fetchQueries(config, accessToken), fetchPosts(config)]);
        const classified = classifyQueries(filterAndSortQueries(rows), posts);
        const markdown = renderMarkdown(site, classified);
        const file = join(outputDir, config.output);
        if (!args.dryRun) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, markdown, 'utf8');
          await chmod(file, 0o666);
        }
        const newCount = classified.filter((row) => row.match.type === 'NEW').length;
        summary.sites[site] = {
          new: newCount, refresh: classified.length - newCount, posts: posts.length, queries: rows.length,
          file, bytes: Buffer.byteLength(markdown), dryRun: args.dryRun,
        };
        if (newCount > 30) summary.warnings.push(`${site}: matching 可能失效`);
      } catch (error) {
        failed = true;
        const warning = `${site}: ${error.message}`;
        console.error(warning);
        summary.warnings.push(warning);
        summary.sites[site] = { error: error.message };
      }
    }
  } catch (error) {
    failed = true;
    console.error(error.message);
    summary.warnings.push(error.message);
  }
  if (failed) process.exitCode = 1;
  console.log(JSON.stringify(summary));
}

await main();
