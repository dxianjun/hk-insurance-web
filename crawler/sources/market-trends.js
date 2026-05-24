/**
 * sources/market-trends.js — 市场趋势 + 行业新闻爬虫
 *
 * 数据来源：
 *   1. 香港保监局(IA) — https://www.ia.org.hk/ — 季度市场统计
 *   2. 保险业监管局新闻稿
 *   3. 各保险公司官网新产品公告
 *
 * 更新频率：每周（数据变化慢）
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import fs from 'node:fs';
import { fetchWithRetry, stripHtml } from '../utils/fetchWithRetry.js';
import { readDataFile, writeDataFile, updateMetadata } from '../utils/diffDetector.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');

/**
 * 从保监局获取最新市场统计
 */
async function crawlIAStatistics() {
  console.log('[市场] 检查保监局统计数据…');
  const urls = [
    'https://www.ia.org.hk/sc/infocenter/statistics/market.html',
    'https://www.ia.org.hk/en/infocenter/statistics/market.html',
  ];

  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url, { retries: 2, timeout: 12000 });
      if (!res.ok) continue;

      const html = await res.text();
      const $ = cheerio.load(html);

      const stats = [];

      // 提取统计数字
      $('.stat-figure, .figure, .number-highlight, .stat-number').each((_i, el) => {
        const val = stripHtml($(el).text());
        const label = stripHtml($(el).parent().find('.label, .stat-label, .caption').first().text());
        if (val && /[\d,]+亿/.test(val)) {
          stats.push({ value: val, label: label || '' });
        }
      });

      // 表格中的统计
      $('table td').each((_i, td) => {
        const text = stripHtml($(td).text());
        if (/[\d,]+亿|[\d.]+%/.test(text) && text.length < 30) {
          const header = stripHtml($(td).parent().find('th, td:first-child').first().text());
          stats.push({ value: text, label: header || '' });
        }
      });

      if (stats.length > 0) {
        console.log(`[市场] IA 提取 ${stats.length} 个统计数字`);
        // 更新发布日期
        const pubDate = stripHtml($('.publish-date, .release-date, .date').first().text()) || new Date().toISOString().slice(0, 10);
        return { stats, pubDate, source: '香港保监局' };
      }
    } catch (err) {
      console.warn(`[市场] IA ${url} 失败: ${err.message}`);
    }
  }
  return null;
}

/**
 * 检测新产品发布公告
 * 检查各公司新闻页面
 */
async function detectNewProducts() {
  console.log('[市场] 检查新产品公告…');

  // 检查几个主要新闻源
  const newsURLs = [
    'https://www.ia.org.hk/sc/infocenter/press_releases.html',
    'https://www.aia.com.hk/zh-hk/about-aia/media-center/press-releases',
  ];

  const newProducts = [];

  for (const url of newsURLs) {
    try {
      const res = await fetchWithRetry(url, { retries: 1, timeout: 10000 });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      $('a, .news-item, .press-release, article').each((_i, el) => {
        const title = stripHtml($(el).find('h2,h3,h4,.title').first().text() || $(el).text());
        if (/保险|储蓄|医疗|危疾|自愿医保|VHIS|分红|年金/i.test(title) &&
            /推出|发布|上市|新产|new product/i.test(title)) {
          const date = stripHtml($(el).find('.date, .time, time').first().text());
          newProducts.push({ title, date: date || '未知', source: url });
        }
      });

      if (newProducts.length > 0) break;
    } catch (err) {
      // 静默失败
    }
  }

  console.log(`[市场] 检测到 ${newProducts.length} 个可能的新产品公告`);
  return newProducts;
}

/**
 * 主入口
 */
export async function checkMarketUpdates(options = {}) {
  const dryRun = options.dryRun || false;

  console.log('\n======== 市场趋势更新 ========');

  let hasChanges = false;
  const changes = {};

  // 1. 检查 IA 统计数据
  const iaData = await crawlIAStatistics();
  if (iaData && iaData.stats.length > 0) {
    const current = readDataFile(DATA_DIR, 'market-trends.json');
    if (current?.stats) {
      const oldValues = current.stats.map(s => s.value).join('|');
      const newValues = iaData.stats.map(s => s.value).join('|');
      if (oldValues !== newValues) {
        console.log('[市场] 🔄 市场统计数据有更新');
        changes.stats = iaData.stats;
        hasChanges = true;
      }
    } else {
      changes.stats = iaData.stats;
      hasChanges = true;
    }
  }

  // 2. 检查新产品公告
  const newProducts = await detectNewProducts();
  if (newProducts.length > 0) {
    console.log('[市场] 🔄 检测到新产品公告');
    changes.newProducts = newProducts;
    hasChanges = true;
  }

  if (!hasChanges) {
    console.log('[市场] ✅ 市场数据无变化');
    return { changed: false, summary: '无变化' };
  }

  // 3. 更新 JSON
  if (!dryRun) {
    const current = readDataFile(DATA_DIR, 'market-trends.json') || {};
    const updated = {
      ...current,
      version: new Date().toISOString().slice(0, 10),
      lastUpdated: new Date().toISOString(),
      stats: changes.stats || current.stats,
    };

    // 如果有新产品公告，追加到 timeline
    if (changes.newProducts && changes.newProducts.length > 0) {
      const timeline = current.timeline || [];
      changes.newProducts.forEach(p => {
        if (!timeline.find(t => t.description.includes(p.title.substring(0, 10)))) {
          timeline.unshift({ date: p.date, description: p.title });
        }
      });
      updated.timeline = timeline.slice(0, 20); // 保留最近 20 条
    }

    writeDataFile(DATA_DIR, 'market-trends.json', updated);
    updateMetadata(DATA_DIR, { marketUpdated: true });
    console.log(`[市场] ✅ 已更新 market-trends.json`);
  } else {
    console.log('[市场] 🔍 干跑模式：不写入文件');
  }

  return { changed: true, changes };
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  checkMarketUpdates().then(r => console.log('\n完成:', JSON.stringify(r, null, 2)));
}
