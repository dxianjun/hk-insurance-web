/**
 * sources/dividend-checker.js — 分红实现率爬虫（23家公司全覆盖）
 *
 * v2 改进：
 * - 从 company-urls.json 读取全部 23 家 URL
 * - manual=true 的公司跳过自动爬取（输出人工维护提示）
 * - 支持并发批处理 + 频控
 * - 自动检测页面结构变化
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import fs from 'node:fs';
import { fetchWithRetry, stripHtml, extractNumber } from '../utils/fetchWithRetry.js';
import { diffArrays, readDataFile, writeDataFile, updateMetadata } from '../utils/diffDetector.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');
const __dirname = import.meta.dirname;

// 加载公司 URL 配置
function loadCompanyConfig() {
  const configPath = path.join(__dirname, 'company-urls.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * 解析分红实现率 HTML 表格
 * 支持页面结构变化时自适应不同表格格式
 */
function parseDividendTable(html, companyName) {
  const $ = cheerio.load(html);
  const results = [];

  // 策略1：标准 <table> 标签
  $('table').each((_i, table) => {
    const headers = [];
    $(table).find('thead th, thead td, tr:first-child th, tr:first-child td').each((_j, th) => {
      headers.push(stripHtml($(th).text()));
    });

    const headerText = headers.join(' ');
    const isDividendTable =
      /分红|实现率|fulfillment|dividend|履行比率/i.test(headerText) ||
      /产品名称|product|plan name/i.test(headerText);

    if (!isDividendTable) return;

    $(table).find('tbody tr, tr').each((_j, row) => {
      const cells = [];
      $(row).find('td, th').each((_k, cell) => {
        cells.push(stripHtml($(cell).text()));
      });

      if (cells.length < 2) return;
      if (/产品|product|合计|total|年份|year/i.test(cells[0])) return;

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

  // 策略2：div/卡片结构（现代网站）
  if (results.length === 0) {
    $('.dividend-item, .product-row, [data-dividend], .card-dividend, .ratio-item').each((_i, el) => {
      const product = stripHtml($(el).find('.product-name, h3, h4, .name').first().text());
      const rate = extractNumber($(el).find('.rate, .percentage, .value, .ratio').first().text());
      if (product && rate !== null) {
        results.push({ company: companyName, product, latestYear: rate });
      }
    });
  }

  return results;
}

/**
 * 爬取单家公司
 * @returns {{success: boolean, data?: Array, error?: string, manual?: boolean}}
 */
async function crawlOneCompany(companyName, config) {
  // 标记为手动维护的公司
  if (config.manual) {
    console.log(`  [${companyName}] ⚐ 人工维护 — ${config.manualNote || '无API端点'}`);
    return { success: false, manual: true, reason: config.manualNote || '需人工维护' };
  }

  if (!config.dividendUrl) {
    console.log(`  [${companyName}] ⚐ 无分红URL`);
    return { success: false, manual: true, reason: '无公开分红页面URL' };
  }

  try {
    console.log(`  [${companyName}] 爬取中…`);
    const res = await fetchWithRetry(config.dividendUrl, {
      retries: 2,
      timeout: 15000,
    });

    if (!res.ok) {
      console.warn(`  [${companyName}] HTTP ${res.status} — 可能需要更新URL`);
      // 尝试 HTTPS → HTTP fallback
      if (config.dividendUrl.startsWith('https://')) {
        const httpUrl = config.dividendUrl.replace('https://', 'http://');
        try {
          const httpRes = await fetchWithRetry(httpUrl, { retries: 1, timeout: 10000 });
          if (httpRes.ok) {
            const html = await httpRes.text();
            const data = parseDividendTable(html, companyName);
            console.log(`  [${companyName}] ✅ HTTP fallback成功，${data.length}条`);
            return { success: true, data };
          }
        } catch (_) {}
      }
      return { success: false, reason: `HTTP ${res.status}` };
    }

    const html = await res.text();

    // 检查空/占位页面
    if (/暂无|维护中|coming soon|page not found|404/i.test(html.substring(0, 500))) {
      console.warn(`  [${companyName}] 页面暂不可用`);
      return { success: false, reason: '页面暂不可用' };
    }

    const data = parseDividendTable(html, companyName);
    console.log(`  [${companyName}] ✅ ${data.length}条数据`);
    return { success: data.length > 0, data, reason: data.length === 0 ? '未提取到数据（页面结构可能已变化）' : null };
  } catch (err) {
    console.warn(`  [${companyName}] ❌ ${err.message}`);
    return { success: false, reason: err.message };
  }
}

/**
 * 主入口
 */
export async function checkDividendUpdates(options = {}) {
  const dryRun = options.dryRun || false;

  console.log('\n======== 分红实现率检查（23家全覆盖）========');

  const config = loadCompanyConfig();
  const entries = Object.entries(config.companies);

  let autoSuccess = 0;
  let autoFail = 0;
  let manualCount = 0;
  const allNewData = [];
  const failedCompanies = [];
  const manualCompanies = [];

  // 并发批处理（每批3家，批次间延迟5秒）
  const CONCURRENCY = 3;
  const BATCH_DELAY = 5000;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(([name, cfg]) => crawlOneCompany(name, cfg))
    );

    batchResults.forEach((result, idx) => {
      const companyName = batch[idx][0];
      if (result.manual) {
        manualCount++;
        manualCompanies.push({ company: companyName, reason: result.reason });
      } else if (result.success && result.data && result.data.length > 0) {
        autoSuccess++;
        allNewData.push(...result.data);
      } else {
        autoFail++;
        failedCompanies.push({ company: companyName, reason: result.reason });
      }
    });

    // 批次间延迟
    if (i + CONCURRENCY < entries.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  console.log(`\n[分红] 汇总: ${autoSuccess}家成功, ${autoFail}家失败, ${manualCount}家人工维护`);

  // 生成状态报告
  const statusReport = {
    timestamp: new Date().toISOString(),
    total: entries.length,
    autoSuccess,
    autoFail,
    manualCount,
    failedCompanies: failedCompanies.map(f => f.company),
    manualCompanies: manualCompanies.map(f => f.company),
  };

  if (failedCompanies.length > 0) {
    console.log('[分红] 失败的公司:');
    failedCompanies.forEach(f => console.log(`  - ${f.company}: ${f.reason}`));
  }

  if (allNewData.length === 0) {
    console.log('[分红] 所有自动公司均无数据，保持现有数据不变');
    return {
      changed: false,
      statusReport,
      error: autoFail === entries.length - manualCount ? '全部自动爬取失败' : '无新数据',
    };
  }

  // 对比新旧数据
  const current = readDataFile(DATA_DIR, 'dividend.json');
  const oldProducts = current?.products || [];

  const oldWithKey = oldProducts.map(p => ({ ...p, _key: `${p.company}|${p.product}` }));
  const newWithKey = allNewData.map(p => ({ ...p, _key: `${p.company}|${p.product}` }));

  const diff = diffArrays(oldWithKey, newWithKey, '_key');

  if (!diff.hasChanges) {
    console.log('[分红] ✅ 数据无变化');
    return { changed: false, statusReport, summary: '无变化' };
  }

  console.log(`[分红] 🔄 有更新: ${diff.summary}`);

  if (!dryRun) {
    const updated = {
      ...current,
      version: new Date().toISOString().slice(0, 10),
      lastUpdated: new Date().toISOString(),
      source: '各保险公司官网（自动爬取，23家全覆盖）',
      products: allNewData,
      statusReport,
    };
    writeDataFile(DATA_DIR, 'dividend.json', updated);
    updateMetadata(DATA_DIR, { version: updated.version, dividendUpdated: true });
    console.log(`[分红] ✅ 已更新（${allNewData.length}条）`);
  } else {
    console.log(`[分红] 🔍 干跑模式：检测到变化但不写入`);
  }

  return {
    changed: true,
    statusReport,
    summary: diff.summary,
    added: diff.added,
    changed: diff.changed,
  };
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  checkDividendUpdates().then(r => {
    console.log('\n完成:', JSON.stringify({
      changed: r.changed,
      summary: r.summary,
      status: r.statusReport,
    }, null, 2));
  });
}
