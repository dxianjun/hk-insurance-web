/**
 * cron.js — 爬虫调度入口
 *
 * 调用方式：
 *   node cron.js               # 运行全部爬虫
 *   node cron.js --dry-run     # 干跑模式（不修改文件）
 *   node cron.js promotions    # 仅运行优惠爬虫
 *   node cron.js dividend      # 仅运行分红爬虫
 */
import path from 'node:path';
import fs from 'node:fs';
import { crawlPromotions } from './sources/promotions.js';
import { checkDividendUpdates } from './sources/dividend-checker.js';
import { checkRatingUpdates } from './sources/ratings.js';
import { autoCommit, generateCommitMessage, generateReport } from './utils/gitCommit.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const REPORT_DIR = path.resolve(import.meta.dirname, '..', 'crawler', 'reports');
const IS_CI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;

// 创建报告目录
if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyPromotions = args.includes('promotions') || args.length === 0; // 默认全跑
const onlyDividend = args.includes('dividend') || args.length === 0;
const onlyRatings = args.includes('ratings') || args.length === 0;

console.log('╔══════════════════════════════════╗');
console.log('║  香港保险数据爬虫 v1.1         ║');
console.log('║  ' + new Date().toISOString() + '     ║');
console.log('╚══════════════════════════════════╝');
console.log('模式:', dryRun ? '干跑（不修改文件）' : '正式运行');
console.log('环境:', IS_CI ? 'GitHub Actions' : '本地');
console.log('');

const results = {};
const startTime = Date.now();

try {
  // ── 1. 优惠信息 ──────────────────────────────────
  if (onlyPromotions) {
    console.log('▸ 任务 1/3: 优惠信息爬虫');
    results.promotions = await crawlPromotions({ dryRun });
    console.log('');
  }

  // ── 2. 分红实现率（23家全覆盖）────────────────────
  if (onlyDividend) {
    console.log('▸ 任务 2/3: 分红实现率检查');
    results.dividend = await checkDividendUpdates({ dryRun });
    console.log('');
  }

  // ── 3. 公司评级 ──────────────────────────────────
  if (onlyRatings) {
    console.log('▸ 任务 3/3: 公司评级检查');
    results.ratings = await checkRatingUpdates({ dryRun });
    console.log('');
  }
} catch (err) {
  console.error('\n❌ 爬虫运行异常:', err.message);
  console.error(err.stack);
  process.exit(1);
}

// ── 汇总 ────────────────────────────────────────────
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('═══════════════════════════════════');
console.log('运行完成，耗时', elapsed, '秒');
console.log('');

let anyChanges = false;
for (const [name, result] of Object.entries(results)) {
  if (result.changed) {
    console.log(`  🔄 ${name}: ${result.summary || '有变化'}`);
    anyChanges = true;
  } else {
    const reason = result.error || '无变化';
    console.log(`  ✅ ${name}: ${reason}`);
  }
}

// ── 生成报告 ────────────────────────────────────────
const report = generateReport(results);
const reportPath = path.join(REPORT_DIR, `report-${new Date().toISOString().slice(0, 10)}.md`);
if (!dryRun) {
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`\n📄 报告已保存: ${reportPath}`);
}

// ── Git 提交（仅在 CI 环境且有变化时） ──────────────
if (IS_CI && anyChanges && !dryRun) {
  console.log('\n📤 正在提交到 Git…');
  const msg = generateCommitMessage(results);
  const commitResult = autoCommit(msg);

  if (commitResult.success && !commitResult.skipped) {
    console.log('✅ 已推送到 GitHub → 自动触发 Vercel 部署');
  }
} else if (!IS_CI) {
  console.log('\n💡 本地模式：数据文件已更新，请手动 git commit');
}

// ── 退出码：有变化时返回 1 让 GitHub Actions 知道 ──
process.exit(0);
