/**
 * sources/products.js — 产品数据变更检测
 *
 * 覆盖：
 *   savings.json   — 储蓄/分红险（IRR/单利/回本期）
 *   medical.json   — 高端医疗险
 *   vhis.json      — VHIS自愿医保
 *   ci.json        — 危疾险
 *
 * 数据来源策略（按可靠性排序）：
 *   1. 10Life 保险对比平台 — https://www.10life.com/zh-HK
 *   2. 港险智平台 — https://www.gangxianzhi.com
 *   3. 各保险公司官网"产品"页面 — 新产品发布公告
 *
 * 产品IRR/单利数据更新难度高（多为PDF保单说明书），P3采用：
 *   - 自动检测对比平台是否出现新产品/下架
 *   - 有变化时生成 diff 报告，人工审核IRR数据
 *   - 提供 manual update 模板
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import fs from 'node:fs';
import { fetchWithRetry, stripHtml } from '../utils/fetchWithRetry.js';
import { diffArrays, readDataFile, writeDataFile, updateMetadata } from '../utils/diffDetector.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');

/**
 * 从 10Life 储蓄保险对比页爬取产品列表
 * URL: https://www.10life.com/zh-HK/products/savings
 */
async function crawl10LifeProducts() {
  console.log('[产品] 检查 10Life 储蓄险对比…');
  const url = 'https://www.10life.com/zh-HK/products/savings';

  try {
    const res = await fetchWithRetry(url, {
      retries: 2,
      timeout: 15000,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-HK,zh;q=0.9',
      },
    });

    if (!res.ok) {
      console.warn(`[产品] 10Life HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const products = [];

    // 策略1：卡片布局
    $('.product-card, .plan-card, [data-testid="product-card"]').each((_i, el) => {
      const name = stripHtml($(el).find('.product-name, .plan-name, h3, h4').first().text());
      const company = stripHtml($(el).find('.company-name, .insurer-name').first().text());
      if (name && name.length > 1) {
        products.push({ name, company, source: '10Life' });
      }
    });

    // 策略2：表格行
    if (products.length === 0) {
      $('table tbody tr').each((_i, row) => {
        const cells = [];
        $(row).find('td').each((_j, td) => cells.push(stripHtml($(td).text())));
        if (cells.length >= 2 && cells[0].length > 2) {
          products.push({ name: cells[0], company: cells[1] || '', source: '10Life' });
        }
      });
    }

    // 策略3：<a> 链接中的产品名
    if (products.length === 0) {
      $('a[href*="product"], a[href*="plan"], a[href*="insurance"]').each((_i, el) => {
        const text = stripHtml($(el).text());
        if (text.length > 3 && text.length < 60 && !/了解|详情|立即|申请|比较/i.test(text)) {
          products.push({ name: text, company: '', source: '10Life' });
        }
      });
    }

    console.log(`[产品] 10Life 提取 ${products.length} 个产品`);
    return products.length > 0 ? products : null;
  } catch (err) {
    console.warn(`[产品] 10Life 失败: ${err.message}`);
    return null;
  }
}

/**
 * 从产品名提取公司名（基于已知公司列表）
 */
function inferCompany(productName, companyList) {
  for (const company of companyList) {
    const shortNames = [
      company,
      company.replace('保险', '').replace('人寿', '').replace('香港', '').replace('(亚洲)', ''),
    ];
    for (const sn of shortNames) {
      if (sn.length >= 2 && productName.includes(sn)) return company;
    }
  }
  return '';
}

/**
 * 对比产品列表变化
 */
async function compareProducts(dataType, dataKey, currentProducts, scrapedProducts) {
  const oldNames = currentProducts.map(p => p.name);
  const newNames = scrapedProducts.map(p => p.name);

  const oldSet = new Set(oldNames);
  const newSet = new Set(newNames);

  const added = scrapedProducts.filter(p => !oldSet.has(p.name));
  const removed = currentProducts.filter(p => !newSet.has(p.name));

  // 名称相似度检测（产品可能改名）
  const renamed = [];
  for (const r of removed) {
    for (const a of added) {
      const similarity = r.name.length > 0 && a.name.length > 0
        ? Math.max(r.name.length, a.name.length) - levenshtein(r.name, a.name)
        : 0;
      const threshold = Math.min(r.name.length, a.name.length) * 0.4;
      if (similarity >= threshold && r.company === a.company) {
        renamed.push({ old: r.name, new: a.name, company: r.company });
      }
    }
  }

  console.log(`[产品] ${dataType}: 新增${added.length} 下架${removed.length} 改名${renamed.length}`);

  return { dataType, dataKey, added, removed, renamed, hasChanges: added.length + removed.length > 0 };
}

/** 字符串编辑距离 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+(a[i-1]!==b[j-1]?1:0));
  return dp[m][n];
}

/**
 * 主入口
 */
export async function checkProductUpdates(options = {}) {
  const dryRun = options.dryRun || false;

  console.log('\n======== 产品数据变更检测 ========');

  // 1. 爬取对比平台
  let scrapedProducts = await crawl10LifeProducts();

  if (!scrapedProducts || scrapedProducts.length === 0) {
    console.log('[产品] 对比平台无数据，无法检测变化');
    return {
      changed: false,
      error: '对比平台数据不可用（页面可能需JS渲染或不在服务区）',
      note: '产品IRR/单利数据请从保险公司保单说明书 PDF 或经纪平台获取后手动更新',
    };
  }

  // 2. 加载当前数据
  const savingsData = readDataFile(DATA_DIR, 'savings.json');
  const currentProducts = savingsData?.products || [];

  // 3. 从 companies.json 加载公司列表（用于推断公司）
  const companiesData = readDataFile(DATA_DIR, 'companies.json');
  const companyNames = (companiesData?.companies || []).map(c => c.name);

  // 4. 为抓取的产品推断公司
  const enrichedProducts = scrapedProducts.map(p => ({
    ...p,
    company: p.company || inferCompany(p.name, companyNames),
  }));

  // 5. 对比
  const result = await compareProducts('储蓄险', 'savings', currentProducts, enrichedProducts);

  // 6. 其他产品类型（medical/vhis/ci）通过官网检查新产品公告
  // 医疗/VHIS/危疾产品更新频率低，P3阶段主要依赖手动

  if (!result.hasChanges) {
    console.log('[产品] ✅ 产品列表无变化');
    return { changed: false, summary: '产品列表无变化' };
  }

  console.log(`\n[产品] 🔄 检测到变化！`);
  if (result.added.length > 0) {
    console.log('  新增产品:');
    result.added.forEach(p => console.log(`    + ${p.name} (${p.company})`));
  }
  if (result.removed.length > 0) {
    console.log('  可能下架:');
    result.removed.forEach(p => console.log(`    - ${p.name} (${p.company})`));
  }
  if (result.renamed.length > 0) {
    console.log('  可能改名:');
    result.renamed.forEach(r => console.log(`    ~ ${r.old} → ${r.new} (${r.company})`));
  }

  console.log('\n[产品] ⚠ 产品IRR/单利数据需要从保单说明书PDF获取');
  console.log('[产品] 请人工核实变化后，更新 data/savings.json');

  return {
    changed: true,
    summary: `新增${result.added.length} 下架${result.removed.length} 改名${result.renamed.length}`,
    added: result.added,
    removed: result.removed,
    renamed: result.renamed,
    needsManualReview: true,
    manualReviewNote: '产品IRR/单利/回本期数据需从保单说明书PDF或经纪平台获取后手动填写',
  };
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  checkProductUpdates().then(r => {
    console.log('\n完成:', JSON.stringify({
      changed: r.changed,
      summary: r.summary,
      needsManualReview: r.needsManualReview,
    }, null, 2));
  });
}
