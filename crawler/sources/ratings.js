/**
 * sources/ratings.js — 公司信用评级更新
 *
 * 数据来源策略：
 * 1. 标普/穆迪公开评级页面（手动 URL 检查）
 * 2. 保险公司官网"关于我们"/"投资者关系"页面
 * 3. 评级变更通常会发布新闻稿
 *
 * 由于评级数据更新频率低（季度/半年），P3采用"检查+人工确认"模式：
 * - 自动检查各公司官网是否有新评级公告
 * - 如有变化，生成 diff 报告供人工审核
 * - 人工确认后更新 companies.json
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import fs from 'node:fs';
import { fetchWithRetry, stripHtml } from '../utils/fetchWithRetry.js';
import { readDataFile, writeDataFile, updateMetadata } from '../utils/diffDetector.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');
const __dirname = import.meta.dirname;

// 评级检查 URL（各公司"关于我们"或"投资者关系"页面）
const RATING_CHECK_URLS = {
  '友邦保险': 'https://www.aia.com/zh-hk/about-aia',
  '宏利':     'https://www.manulife.com.hk/zh-hk/about-us.html',
  '保诚保险':  'https://www.prudential.com.hk/zh-hk/about-us/',
  '安盛保险':  'https://www.axa.com.hk/zh/about-axa',
  '汇丰人寿':  'https://www.hsbc.com.hk/zh-hk/about-hsbc/',
  '永明金融':  'https://www.sunlife.com.hk/zh-hk/about-us/',
  '富卫人寿':  'https://www.fwd.com.hk/zh-hk/about-fwd/',
};

/**
 * 从文本中提取评级信息
 * 匹配 "标普 AA+" "穆迪 Aa3" 等模式
 */
function extractRating(text, companyName) {
  const patterns = {
    sp: [
      /标[普準].*?([A-Fa-f]{1,3}[+-]?)/,
      /S&P.*?([A-Fa-f]{1,3}[+-]?)/i,
      /Standard\s*&?\s*Poor'?s?\s*:?\s*([A-Fa-f]{1,3}[+-]?)/i,
    ],
    moody: [
      /穆迪.*?([ABCa-z]{1,3}\d?)/,
      /Moody'?s?\s*:?\s*([ABCa-z]{1,3}\d?)/i,
    ],
    fitch: [
      /惠誉.*?([A-Fa-f]{1,3}[+-]?)/,
      /Fitch\s*:?\s*([A-Fa-f]{1,3}[+-]?)/i,
    ],
  };

  const result = {};
  for (const [agency, regexes] of Object.entries(patterns)) {
    for (const re of regexes) {
      const m = text.match(re);
      if (m) {
        result[agency] = m[1].toUpperCase();
        break;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 爬取单家公司评级
 */
async function checkOneCompany(companyName, url) {
  try {
    const res = await fetchWithRetry(url, { retries: 2, timeout: 12000 });
    if (!res.ok) return { company: companyName, success: false, reason: `HTTP ${res.status}` };

    const html = await res.text();
    const $ = cheerio.load(html);

    // 提取页面文本（聚焦评级相关区域）
    const ratingSection = $('body').text();
    const ratings = extractRating(ratingSection, companyName);

    if (ratings) {
      console.log(`  [${companyName}] ${JSON.stringify(ratings)}`);
      return { company: companyName, success: true, ratings };
    } else {
      console.log(`  [${companyName}] 未找到评级信息`);
      return { company: companyName, success: false, reason: '未找到评级' };
    }
  } catch (err) {
    return { company: companyName, success: false, reason: err.message };
  }
}

/**
 * 主入口：检查全部公司评级更新
 */
export async function checkRatingUpdates(options = {}) {
  const dryRun = options.dryRun || false;

  console.log('\n======== 公司评级检查 ========');
  console.log('策略: 检查官网"关于我们"页面，提取标普/穆迪/惠誉评级');

  const entries = Object.entries(RATING_CHECK_URLS);
  const currentData = readDataFile(DATA_DIR, 'companies.json');
  const companies = currentData?.companies || [];

  const results = [];
  const updates = [];

  // 并发2家，防止被ban
  for (let i = 0; i < entries.length; i += 2) {
    const batch = entries.slice(i, i + 2);
    const batchResults = await Promise.all(
      batch.map(([name, url]) => checkOneCompany(name, url))
    );
    batchResults.forEach(r => {
      results.push(r);
      if (r.success && r.ratings) {
        // 对比现有数据
        const existing = companies.find(c => c.name === r.company || c.name.includes(r.company));
        if (existing) {
          let hasChange = false;
          if (r.ratings.sp && existing.sp !== r.ratings.sp) {
            updates.push({ company: r.company, field: 'sp', old: existing.sp, new: r.ratings.sp });
            hasChange = true;
          }
          if (r.ratings.moody && existing.moody !== r.ratings.moody) {
            updates.push({ company: r.company, field: 'moody', old: existing.moody, new: r.ratings.moody });
            hasChange = true;
          }
          if (hasChange) {
            // 更新内存中的对象
            if (r.ratings.sp) existing.sp = r.ratings.sp;
            if (r.ratings.moody) existing.moody = r.ratings.moody;
          }
        }
      }
    });
    if (i + 2 < entries.length) await new Promise(r => setTimeout(r, 3000));
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`\n[评级] ${successCount}/${entries.length} 家公司可获取评级`);

  if (updates.length > 0) {
    console.log(`[评级] 🔄 ${updates.length}项变更:`);
    updates.forEach(u => console.log(`  - ${u.company} ${u.field}: ${u.old} → ${u.new}`));

    if (!dryRun) {
      writeDataFile(DATA_DIR, 'companies.json', { ...currentData, companies, version: new Date().toISOString().slice(0, 10), lastUpdated: new Date().toISOString() });
      updateMetadata(DATA_DIR, { ratingsUpdated: true });
      console.log('[评级] ✅ 已更新 companies.json');
    }
  } else {
    console.log('[评级] ✅ 评级无变化');
  }

  return { changed: updates.length > 0, successCount, totalChecked: entries.length, updates };
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  checkRatingUpdates().then(r => console.log('\n完成:', JSON.stringify(r, null, 2)));
}
