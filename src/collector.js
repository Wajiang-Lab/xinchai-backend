/**
 * 信差 - 情报采集器
 * 负责从多个 RSS 源抓取最新资讯
 *
 * v2 改进：
 * - 内存缓存（1 小时 TTL）
 * - 串行采集 + 随机间隔，避免 429
 * - fetchWithRetry 失败重试（网络错误/5xx/429 重试 1 次，404/406 跳过）
 * - 多源降级方案（HN Algolia JSON / GitHub Trending HTML / Reddit JSON / Anthropic RSS）
 */

const https = require('https');
const http = require('http');
const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 15000,
  maxRedirects: 3,
  customFields: {
    item: [['media:content', 'media']],
  },
  headers: {
    'User-Agent': 'XinChai-Bot/1.0 (RSS Aggregator)',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  }
});

// ============================================
// RSS 源配置
// ============================================
const SOURCES = [
  { id: 'hn', name: 'Hacker News', url: 'https://hnrss.org/frontpage?points=100', fallback: 'https://hn.algolia.com/api/v1/search?tags=front_page', fallbackType: 'hn-json', category: 'AI-Agent', maxItems: 5 },
  { id: 'github-trending', name: 'GitHub Trending', url: '', fallback: 'https://github.com/trending', fallbackType: 'github-html', category: 'dev-tools', maxItems: 5 },
  { id: 'openai-blog', name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', fallback: '', category: 'AI-Agent', maxItems: 3 },
  { id: 'reddit-obsidian', name: 'Reddit r/ObsidianMD', url: 'https://www.reddit.com/r/ObsidianMD/.rss', fallback: 'https://www.reddit.com/r/ObsidianMD.json', fallbackType: 'reddit-json', category: 'productivity', maxItems: 3 },
  { id: 'huggingface', name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', fallback: '', category: 'AI-Agent', maxItems: 3 },
  { id: 'tldr-ai', name: 'TLDR AI', url: 'https://tldr.tech/api/rss/ai', fallback: '', category: 'AI-Agent', maxItems: 5 },
];

const VALID_CATEGORIES = ['AI-Agent', 'dev-tools', 'productivity', 'other'];
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

// ============================================
// 缓存层：key = source.id, value = {items, ts}
// ============================================
const cache = new Map();
const CACHE_TTL = 3600000; // 1 小时

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// HTTP GET 辅助（支持有限重定向，返回 {data, statusCode}）
// ============================================
function httpGet(url, { headers = {}, timeout = 15000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const doRequest = (targetUrl) => {
      let u;
      try { u = new URL(targetUrl); } catch (e) { return reject(new Error('invalid url')); }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(targetUrl, {
        headers: {
          'User-Agent': 'XinChai-Bot/1.0 (RSS Aggregator)',
          'Accept': '*/*',
          ...headers,
        },
        timeout,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects >= maxRedirects) {
            res.resume();
            return reject(new Error(`too many redirects (last status ${res.statusCode})`));
          }
          redirects++;
          const next = new URL(res.headers.location, targetUrl).href;
          res.resume();
          return doRequest(next);
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ data, statusCode: res.statusCode }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    };
    doRequest(url);
  });
}

/**
 * 失败重试封装
 * - 网络错误 / 5xx / 429：等 2 秒重试 1 次
 * - 404 / 406：直接跳过，返回空数组
 * - 仍失败：返回空数组（不抛错）
 *
 * fn 应在需要重试时抛出带 statusCode 的错误（429/5xx）或普通网络错误；
 * 对 404/406 也可抛带 statusCode 的错误，本函数会直接跳过。
 */
async function fetchWithRetry(fn, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.statusCode || err.status;
      // 404 / 406：不重试，直接返回空
      if (status === 404 || status === 406) {
        console.warn(`  fetchWithRetry skip (${status}): ${err.message}`);
        return [];
      }
      // 仅网络错误（无 status）/ 429 / 5xx 才重试
      const retryable = !status || status === 429 || (status >= 500 && status < 600);
      if (!retryable) {
        console.warn(`  fetchWithRetry skip (${status}): ${err.message}`);
        return [];
      }
      if (attempt < retries) {
        console.warn(`  fetchWithRetry retry (${status || 'network'}): ${err.message}`);
        await sleep(2000);
        continue;
      }
    }
  }
  console.warn(`  fetchWithRetry exhausted: ${lastErr?.message || 'unknown'}`);
  return [];
}

// ============================================
// 抓取单个源（带缓存 + 降级分发）
// ============================================
async function fetchSource(source) {
  // 1. 缓存命中
  const cached = cache.get(source.id);
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
    console.log(`cache-hit: ${source.id}`);
    return cached.items;
  }

  // 2. 带重试地抓取
  const items = await fetchWithRetry(() => fetchSourceInner(source));

  // 3. 写入缓存（无论是否为空，避免短时间内反复打失败的源）
  cache.set(source.id, { items, ts: Date.now() });
  return items;
}

async function fetchSourceInner(source) {
  // 优先主 URL
  if (source.url) {
    try {
      const items = await fetchRSS(source.url, source);
      if (items && items.length > 0) return items;
    } catch (err) {
      console.warn(`  ${source.name} primary failed: ${err.message}, trying fallback`);
    }
  }
  // 降级
  if (source.fallback) {
    switch (source.fallbackType) {
      case 'hn-json':
        return await fetchHNJson(source);
      case 'github-html':
        return await fetchGitHubHtml(source);
      case 'reddit-json':
        return await fetchRedditJson(source);
      default:
        return await fetchRSS(source.fallback, source);
    }
  }
  return [];
}

// ============================================
// 各类型抓取器
// ============================================

async function fetchRSS(url, source) {
  const feed = await parser.parseURL(url);
  return (feed.items || []).slice(0, source.maxItems).map(item => normalizeItem(item, source))
    .filter(item => item.title && item.title.length > 0);
}

async function fetchHNJson(source) {
  const { data, statusCode } = await httpGet(source.fallback, { headers: { 'Accept': 'application/json' } });
  if (statusCode >= 400) {
    const err = new Error(`HN algolia ${statusCode}`);
    err.statusCode = statusCode;
    throw err;
  }
  const json = JSON.parse(data);
  const hits = json.hits || [];
  return hits.slice(0, source.maxItems).map(hit => ({
    title: cleanText(hit.title || ''),
    summary: cleanText(hit.story_text || hit.comment_text || '').slice(0, 200),
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    source: source.name,
    sourceId: source.id,
    category: VALID_CATEGORIES.includes(source.category) ? source.category : 'other',
    categoryLabel: getCategoryLabel(source.category),
    time: hit.created_at ? new Date(hit.created_at).toLocaleString('zh-CN') : '',
  })).filter(item => item.title && item.title.length > 0);
}

async function fetchGitHubHtml(source) {
  const { data, statusCode } = await httpGet(source.fallback, { headers: { 'Accept': 'text/html' } });
  if (statusCode >= 400) {
    const err = new Error(`GitHub trending ${statusCode}`);
    err.statusCode = statusCode;
    throw err;
  }
  const html = data;
  const items = [];
  // 匹配 <article class="Box-row"> ... </article> 块
  const articleRe = /<article[^>]*class="Box-row"[\s\S]*?<\/article>/g;
  const articles = html.match(articleRe) || [];
  for (const article of articles.slice(0, source.maxItems)) {
    // <h2> 内的 <a href="/owner/repo">
    const hrefMatch = article.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/);
    const descMatch = article.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!hrefMatch) continue;
    const repoPath = hrefMatch[1];
    const url = repoPath.startsWith('http') ? repoPath : `https://github.com${repoPath}`;
    const repoName = repoPath.replace(/^\//, '').split('/').slice(0, 2).join('/');
    const summary = descMatch ? cleanText(descMatch[1]).slice(0, 200) : '';
    items.push({
      title: repoName,
      summary,
      url: sanitizeUrl(url),
      source: source.name,
      sourceId: source.id,
      category: VALID_CATEGORIES.includes(source.category) ? source.category : 'other',
      categoryLabel: getCategoryLabel(source.category),
      time: '',
    });
  }
  return items;
}

async function fetchRedditJson(source) {
  const { data, statusCode } = await httpGet(source.fallback, { headers: { 'Accept': 'application/json' } });
  if (statusCode >= 400) {
    const err = new Error(`Reddit json ${statusCode}`);
    err.statusCode = statusCode;
    throw err;
  }
  const json = JSON.parse(data);
  const children = (json.data && json.data.children) || [];
  return children.slice(0, source.maxItems).map(child => {
    const d = (child && child.data) || {};
    return {
      title: cleanText(d.title || ''),
      summary: cleanText(d.selftext || '').slice(0, 200),
      url: d.url ? sanitizeUrl(d.url) : '',
      source: source.name,
      sourceId: source.id,
      category: VALID_CATEGORIES.includes(source.category) ? source.category : 'other',
      categoryLabel: getCategoryLabel(source.category),
      time: d.created_utc ? new Date(d.created_utc * 1000).toLocaleString('zh-CN') : '',
    };
  }).filter(item => item.title && item.title.length > 0);
}

function normalizeItem(item, source) {
  const title = cleanText(item.title || '');
  const summary = cleanText(item.contentSnippet || item.content || '').slice(0, 200);
  const url = sanitizeUrl(item.link || '');
  const time = item.isoDate ? new Date(item.isoDate).toLocaleString('zh-CN') : '';
  return {
    title: title.slice(0, 200),
    summary,
    url,
    source: source.name,
    sourceId: source.id,
    category: VALID_CATEGORIES.includes(source.category) ? source.category : 'other',
    categoryLabel: getCategoryLabel(source.category),
    time,
  };
}

// ============================================
// 采集所有源（串行 + 随机间隔，避免 429）
// ============================================
async function collectAll() {
  console.log(`🔍 开始采集 ${SOURCES.length} 个情报源...`);
  const allItems = [];

  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    try {
      const items = await fetchSource(source);
      allItems.push(...items);
      console.log(`  ✅ ${source.name}: ${items.length} 条`);
    } catch (err) {
      console.warn(`  ⚠️ ${source.name}: 失败 - ${err?.message || '未知错误'}`);
    }
    // 每个源之间随机等 1-2 秒（最后一个不等）
    if (i < SOURCES.length - 1) {
      await sleep(1000 + Math.random() * 1000);
    }
  }

  console.log(`📦 共采集到 ${allItems.length} 条原始内容`);
  return allItems;
}

/**
 * 生成日报
 */
async function generateDailyDigest() {
  const rawItems = await collectAll();

  // 去重（标题前 30 字符）
  const seen = new Set();
  const uniqueItems = rawItems.filter(item => {
    const key = (item.title || '').slice(0, 30).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 按分类分组，每类最多 4 条
  const grouped = {};
  for (const item of uniqueItems) {
    const cat = item.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    if (grouped[cat].length < 4) grouped[cat].push(item);
  }

  const items = Object.entries(grouped).flatMap(([cat, catItems]) =>
    catItems.map(item => ({
      id: `${getToday()}-${Math.random().toString(36).slice(2, 10)}`,
      title: item.title,
      summary: item.summary,
      url: item.url,
      category: cat,
      categoryLabel: item.categoryLabel,
      source: item.source,
      time: item.time,
    }))
  );

  const today = getToday();
  const d = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const dateLabel = `${d.getMonth() + 1}月${d.getDate()}日 · ${weekdays[d.getDay()]}`;

  return { date: today, dateLabel, items };
}

// ============================================
// 工具函数
// ============================================

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCategoryLabel(cat) {
  const labels = {
    'AI-Agent': 'AI / 大模型',
    'dev-tools': '开发工具 / 新技术',
    'productivity': '生产力工具',
    'other': '其他关注',
  };
  return labels[cat] || '其他';
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  if (url.length > 2048) return '';
  try {
    const u = new URL(url);
    if (!ALLOWED_PROTOCOLS.includes(u.protocol)) return '';
    return u.href;
  } catch {
    return '';
  }
}

function cleanText(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { collectAll, generateDailyDigest, SOURCES };
