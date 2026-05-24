/**
 * fetchWithRetry.js — 带重试和超时的 fetch 封装
 */
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_DELAY = 2000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch
 * @param {string} url
 * @param {object} options - { retries, timeout, headers }
 * @returns {Promise<{ok:boolean, status:number, text():Promise<string>, json():Promise<object>}>}
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    retries = DEFAULT_RETRIES,
    timeout = DEFAULT_TIMEOUT,
    headers = {},
    ...rest
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8',
          ...headers,
        },
        ...rest,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) {
        throw new Error(`[fetch] ${url} 失败（${retries}次重试后）: ${err.message}`);
      }
      console.warn(`  [fetch] 第${attempt}次失败，${DEFAULT_DELAY}ms 后重试...`);
      await sleep(DEFAULT_DELAY * attempt); // 递增延迟
    }
  }
}

/**
 * 简单的 HTML → 纯文本提取（去除标签）
 */
export function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 提取 HTML 中的数字（用于分红实现率等百分比数据）
 * @param {string} text - 包含数字的文本
 * @returns {number|null}
 */
export function extractNumber(text) {
  const cleaned = text.replace(/[^\d.%-]/g, '').trim();
  const match = cleaned.match(/([\d.]+)\s*%/);
  if (match) return parseFloat(match[1]);
  const numMatch = cleaned.match(/([\d.]+)/);
  if (numMatch) return parseFloat(numMatch[1]);
  return null;
}
