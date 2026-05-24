/**
 * sources/promotions.js — 优惠信息爬虫
 *
 * 数据来源策略：
 * 1. 港险智平台 (gangxianzhi.com) — 聚合各公司最新优惠
 * 2. 各保险公司官网"最新优惠"页面
 * 3. 保险经纪公司公开优惠汇总页
 *
 * P1 阶段：主要从港险智平台获取结构化数据
 * 如果爬取失败，返回 null 触发 fallback
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import { fetchWithRetry, stripHtml } from '../utils/fetchWithRetry.js';
import { diffArrays, readDataFile, writeDataFile, updateMetadata } from '../utils/diffDetector.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');

/**
 * 从港险智平台爬取优惠数据
 * URL: https://www.gangxianzhi.com/promotions
 */
async function crawlGangXianZhi() {
  console.log('[优惠] 正在爬取港险智平台…');
  const url = 'https://www.gangxianzhi.com/promotions';

  try {
    const res = await fetchWithRetry(url, { retries: 2, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const prepay = [];    // 预缴利率
    const discount = [];  // 保费折扣

    // 尝试多种选择器适配页面结构
    const tables = $('table');
    tables.each((_i, table) => {
      const headerText = $(table).prev('h2,h3,h4').text() + $(table).find('thead').text();
      const isPrepay = /预缴|利率|prepay/i.test(headerText);
      const isDiscount = /折扣|保费|discount/i.test(headerText);

      $(table).find('tbody tr').each((_j, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;

        const company = stripHtml($(cells.eq(0)).text());
        const detail = stripHtml($(cells.eq(1)).text());

        if (!company || company.length > 20) return;

        if (isPrepay || /预缴/.test(detail)) {
          prepay.push({ company, detail, source: '港险智' });
        } else if (isDiscount || /折扣/.test(detail)) {
          discount.push({ company, detail, source: '港险智' });
        }
      });
    });

    console.log(`[优惠] 从港险智获取：预缴 ${prepay.length} 条，折扣 ${discount.length} 条`);
    return { prepay, discount };
  } catch (err) {
    console.warn('[优惠] 港险智平台爬取失败:', err.message);
    return null;
  }
}

/**
 * 从保险经纪平台爬取优惠（备用源）
 */
async function crawlBrokerPlatform() {
  const sources = [
    { name: '10Life', url: 'https://www.10life.com/zh-HK/promotions' },
  ];

  for (const src of sources) {
    try {
      console.log(`[优惠] 尝试 ${src.name}…`);
      const res = await fetchWithRetry(src.url, { retries: 1, timeout: 10000 });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      const items = [];
      $('.promo-card, .offer-item, article').each((_i, el) => {
        const title = stripHtml($(el).find('h2,h3,h4,.title').first().text());
        const desc = stripHtml($(el).find('p,.desc,.content').first().text());
        if (title) items.push({ company: title, detail: desc, source: src.name });
      });

      if (items.length > 0) {
        console.log(`[优惠] ${src.name} 获取 ${items.length} 条`);
        return { prepay: items.filter(i => /预缴|利率/.test(i.detail)), discount: items.filter(i => /折扣|回赠/.test(i.detail)) };
      }
    } catch (err) {
      console.warn(`[优惠] ${src.name} 失败:`, err.message);
    }
  }
  return null;
}

/**
 * 主入口：对比新旧数据，有变化才更新
 */
export async function crawlPromotions(options = {}) {
  const dryRun = options.dryRun || false;
  console.log('\n======== 优惠信息爬虫 ========');

  // 1. 爬取
  let result = await crawlGangXianZhi();
  if (!result || (result.prepay.length === 0 && result.discount.length === 0)) {
    console.log('[优惠] 主源无数据，尝试备用源…');
    result = await crawlBrokerPlatform();
  }

  if (!result || (result.prepay.length === 0 && result.discount.length === 0)) {
    console.log('[优惠] 所有源均无数据，保持现有数据不变');
    return { changed: false, error: '所有数据源均无法获取' };
  }

  // 2. 读取当前数据
  const current = readDataFile(DATA_DIR, 'promotions.json');
  const oldPrepay = current?.prepay || [];
  const oldDiscount = current?.discount || [];

  // 3. 对比
  const prepayDiff = diffArrays(oldPrepay, result.prepay, 'company');
  const discountDiff = diffArrays(oldDiscount, result.discount, 'company');

  const hasChanges = prepayDiff.hasChanges || discountDiff.hasChanges;
  console.log(`[优惠] 预缴利率变化: ${prepayDiff.summary || '无'}`);
  console.log(`[优惠] 保费折扣变化: ${discountDiff.summary || '无'}`);

  if (!hasChanges) {
    console.log('[优惠] ✅ 数据无变化');
    return { changed: false, summary: '无变化' };
  }

  // 4. 写入新数据
  if (!dryRun) {
    const updated = {
      ...current,
      version: new Date().toISOString().slice(0, 10),
      lastUpdated: new Date().toISOString(),
      source: result.prepay[0]?.source || '网络爬虫',
      prepay: result.prepay,
      discount: result.discount,
    };
    writeDataFile(DATA_DIR, 'promotions.json', updated);

    // 5. 更新 metadata
    updateMetadata(DATA_DIR, {
      version: updated.version,
      promotionsUpdated: true,
    });
    console.log(`[优惠] ✅ 已更新（预缴 ${result.prepay.length} 条，折扣 ${result.discount.length} 条）`);
  } else {
    console.log(`[优惠] 🔍 干跑模式：检测到变化但不写入文件`);
  }
  return {
    changed: true,
    summary: [prepayDiff.summary, discountDiff.summary].filter(Boolean).join('；'),
    added: [...prepayDiff.added, ...discountDiff.added],
    changed: [...prepayDiff.changed, ...discountDiff.changed],
  };
}

// 直接运行时执行
if (import.meta.url === `file://${process.argv[1]}`) {
  crawlPromotions().then(r => {
    console.log('\n完成:', JSON.stringify(r, null, 2));
  });
}
