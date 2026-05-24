/**
 * sources/dividend-checker.js — 分红实现率爬虫
 *
 * 数据来源：
 * 各保险公司官网"分红实现率"专栏
 * 每年年报/中期报告发布后更新
 *
 * P1 策略：
 * - 检查首页是否有新的"分红实现率"公告
 * - 若有更新，通过已知 URL 尝试获取表格数据
 * - 如果页面结构变化，记录并输出 diff 日志（人工审核）
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import { fetchWithRetry, stripHtml, extractNumber } from '../utils/fetchWithRetry.js';
import { diffArrays, readDataFile, writeDataFile, updateMetadata } from '../utils/diffDetector.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');

/**
 * 各保险公司分红实现率页面 URL（已知公开页面）
 */
const DIVIDEND_URLS = {
  '友邦保险': 'https://www.aia.com.hk/zh-hk/dividend-fulfillment-ratio',
  '宏利':     'https://www.manulife.com.hk/zh-hk/individual/dividend.html',
  '保诚保险':  'https://www.prudential.com.hk/zh-hk/dividend/',
  '安盛保险':  'https://www.axa.com.hk/zh/dividend-fulfillment-ratio',
  '汇丰人寿':  'https://www.hsbc.com.hk/zh-hk/insurance/dividend-history/',
  '中银人寿':  'https://www.bocgroup.com.hk/zh-hk/life/dividend.html',
  '富卫人寿':  'https://www.fwd.com.hk/zh-hk/dividend-fulfillment-ratio/',
  '永明金融':  'https://www.sunlife.com.hk/zh-hk/dividend-fulfillment-ratio/',
  '中国人寿海外': 'https://www.chinalife.com.hk/zh-hk/dividend-fulfillment-ratio',
  '恒生保险':  'https://www.hangseng.com/zh-hk/insurance/dividend-fulfillment/',
};

/**
 * 通用表格解析器：尝试从 HTML 提取分红实现率数据
 * 适配多种表格格式
 */
function parseDividendTable(html, companyName) {
  const $ = cheerio.load(html);
  const results = [];

  // 策略1：标准的 <table> 标签
  $('table').each((_i, table) => {
    // 找到表头
    const headers = [];
    $(table).find('thead th, thead td, tr:first-child th, tr:first-child td').each((_j, th) => {
      headers.push(stripHtml($(th).text()));
    });

    // 判断是否是分红实现率表格
    const headerText = headers.join(' ');
    const isDividendTable =
      /分红|实现率|fulfillment|dividend/i.test(headerText) ||
      /产品名称|product/i.test(headerText);

    if (!isDividendTable) return;

    // 解析数据行
    $(table).find('tbody tr, tr').each((_j, row) => {
      const cells = [];
      $(row).find('td, th').each((_k, cell) => {
        cells.push(stripHtml($(cell).text()));
      });

      if (cells.length < 2) return;
      if (/产品|product|合计|total/i.test(cells[0])) return; // 跳过页眉

      const product = cells[0];
      const rates = cells.slice(1).map(extractNumber).filter(Boolean);

      if (product && rates.length > 0) {
        results.push({
          company: companyName,
          product,
          latestYear: rates[0],
          rates,
          raw: cells.slice(1).join(', '),
        });
      }
    });
  });

  // 策略2：div/ul/li 结构（部分现代网站）
  if (results.length === 0) {
    $('.dividend-item, .product-row, [data-dividend]').each((_i, el) => {
      const product = stripHtml($(el).find('.product-name, h3, h4').first().text());
      const rate = extractNumber($(el).find('.rate, .percentage, .value').first().text());
      if (product && rate !== null) {
        results.push({ company: companyName, product, latestYear: rate });
      }
    });
  }

  return results;
}

/**
 * 爬取单家公司分红实现率
 */
async function crawlOneCompany(companyName, url) {
  try {
    console.log(`  [${companyName}] 正在获取…`);
    const res = await fetchWithRetry(url, { retries: 2, timeout: 15000 });
    if (!res.ok) {
      console.warn(`  [${companyName}] HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();

    // 检查页面是否包含"暂无更新"/"维护中"等
    if (/暂无|维护中|coming soon|page not found/i.test(html.substring(0, 500))) {
      console.warn(`  [${companyName}] 页面不可用`);
      return null;
    }

    const data = parseDividendTable(html, companyName);
    console.log(`  [${companyName}] 提取 ${data.length} 条数据`);
    return data;
  } catch (err) {
    console.warn(`  [${companyName}] 错误:`, err.message);
    return null;
  }
}

/**
 * 主入口
 */
export async function checkDividendUpdates(options = {}) {
  const dryRun = options.dryRun || false;
  console.log('\n======== 分红实现率检查 ========');

  const allNewData = [];

  // 限制并发数，避免被 ban
  const entries = Object.entries(DIVIDEND_URLS);
  const concurrency = 3;

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(([name, url]) => crawlOneCompany(name, url))
    );
    results.forEach((data, idx) => {
      if (data && data.length > 0) {
        allNewData.push(...data);
      } else {
        console.log(`  [${batch[idx][0]}] 无数据（页面可能改版或不可用）`);
      }
    });

    // 批次间延迟
    if (i + concurrency < entries.length) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (allNewData.length === 0) {
    console.log('[分红] 所有公司均无数据，保持现有数据不变');
    return {
      changed: false,
      error: '无公司可获取分红数据',
      checked: entries.length,
      successCount: 0,
    };
  }

  console.log(`[分红] 成功获取 ${allNewData.length} 条分红数据`);

  // 读取当前数据做对比
  const current = readDataFile(DATA_DIR, 'dividend.json');
  const oldProducts = current?.products || [];

  // 对比（按 company + product 作为主键）
  const oldWithKey = oldProducts.map(p => ({ ...p, _key: `${p.company}|${p.product}` }));
  const newWithKey = allNewData.map(p => ({ ...p, _key: `${p.company}|${p.product}` }));

  const diff = diffArrays(oldWithKey, newWithKey, '_key');

  if (!diff.hasChanges) {
    console.log('[分红] ✅ 数据无变化');
    return { changed: false, summary: '无变化', checked: entries.length, successCount: allNewData.length };
  }

  console.log(`[分红] 🔄 有更新: ${diff.summary}`);

  if (!dryRun) {
    // 写入更新
    const updated = {
      ...current,
      version: new Date().toISOString().slice(0, 10),
      lastUpdated: new Date().toISOString(),
      source: '各保险公司官网（自动爬取）',
      products: allNewData,
    };
    writeDataFile(DATA_DIR, 'dividend.json', updated);
    updateMetadata(DATA_DIR, { version: updated.version, dividendUpdated: true });
    console.log(`[分红] ✅ 已更新`);
  } else {
    console.log(`[分红] 🔍 干跑模式：检测到变化但不写入文件`);
  }

  return {
    changed: true,
    summary: diff.summary,
    added: diff.added,
    changed: diff.changed,
    checked: entries.length,
    successCount: allNewData.length,
  };
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  checkDividendUpdates().then(r => {
    console.log('\n完成:', JSON.stringify({ changed: r.changed, summary: r.summary }, null, 2));
  });
}
