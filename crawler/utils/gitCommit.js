/**
 * gitCommit.js — 自动提交数据变更到 Git
 * 用于 GitHub Actions 环境，爬虫运行后自动 push
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * 检测是否有文件变更
 */
export function hasChanges() {
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 获取变更文件列表
 */
export function getChangedFiles() {
  try {
    const status = execSync('git diff --name-only', { cwd: ROOT, encoding: 'utf8' });
    return status.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 自动提交并推送
 * @param {string} message - 提交信息
 * @returns {{success: boolean, commitHash?: string, error?: string}}
 */
export function autoCommit(message) {
  try {
    // 配置 Git 用户（GitHub Actions 环境）
    execSync('git config user.name "Data Bot"', { cwd: ROOT });
    execSync('git config user.email "data-bot@hk-insurance.app"', { cwd: ROOT });

    // 暂存 data/ 目录
    execSync('git add data/', { cwd: ROOT });

    // 检查是否有变更
    const status = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' });
    if (!status.trim()) {
      console.log('[git] 无变更，跳过提交');
      return { success: true, skipped: true };
    }

    // 提交
    const commitOutput = execSync(`git commit -m "${message}"`, { cwd: ROOT, encoding: 'utf8' });
    const hashMatch = commitOutput.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
    const commitHash = hashMatch ? hashMatch[1] : 'unknown';

    // 推送
    execSync('git push origin main', { cwd: ROOT, encoding: 'utf8' });

    console.log(`[git] ✅ 已提交并推送: ${message} (${commitHash})`);
    return { success: true, commitHash };
  } catch (err) {
    console.error('[git] ❌ 提交失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 生成自动提交信息
 * @param {object} results - 爬虫运行结果
 */
export function generateCommitMessage(results) {
  const parts = [];
  if (results.promotions?.changed) parts.push('优惠信息');
  if (results.dividend?.changed) parts.push('分红实现率');
  if (results.ratings?.changed) parts.push('公司评级');

  if (parts.length === 0) return '自动爬虫：数据无变更';
  return `自动更新：${parts.join('、')} — ${new Date().toISOString().slice(0, 10)}`;
}

/**
 * 生成报告 Markdown
 */
export function generateReport(results) {
  const date = new Date().toISOString().slice(0, 10);
  let md = `# 数据爬虫运行报告 — ${date}\n\n`;

  for (const [name, result] of Object.entries(results)) {
    md += `## ${name}\n\n`;
    if (result.error) {
      md += `❌ **错误**: ${result.error}\n\n`;
    } else if (!result.changed) {
      md += `✅ 数据无变化\n\n`;
    } else {
      md += `🔄 **有更新**: ${result.summary || ''}\n\n`;
      if (result.added?.length > 0) {
        md += `### 新增 (${result.added.length})\n`;
        result.added.forEach(item => md += `- ${item.key}\n`);
        md += '\n';
      }
      if (result.changed?.length > 0) {
        md += `### 变更 (${result.changed.length})\n`;
        result.changed.slice(0, 10).forEach(item => {
          md += `- **${item.key}**: ${item.diffs.map(d => `${d.field}: ${d.old} → ${d.new}`).join(', ')}\n`;
        });
        md += '\n';
      }
    }
  }

  md += `---\n*报告由数据爬虫自动生成，时间：${new Date().toISOString()}*`;
  return md;
}
