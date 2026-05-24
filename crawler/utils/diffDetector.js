/**
 * diffDetector.js — 检测新旧数据变化
 * 支持：数组对比、对象深度对比、百分比变化阈值
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 对比两个数组，返回变化摘要
 * @param {Array} oldData
 * @param {Array} newData
 * @param {string} keyField - 用于匹配的主键字段名
 * @returns {{added: number, removed: number, changed: Array, summary: string}}
 */
export function diffArrays(oldData, newData, keyField = 'name') {
  const oldMap = new Map(oldData.map(item => [item[keyField], item]));
  const newMap = new Map(newData.map(item => [item[keyField], item]));

  const added = [];
  const removed = [];
  const changed = [];

  // 检查新增
  for (const [key, newItem] of newMap) {
    if (!oldMap.has(key)) {
      added.push({ key, item: newItem });
    }
  }

  // 检查删除
  for (const [key, oldItem] of oldMap) {
    if (!newMap.has(key)) {
      removed.push({ key, item: oldItem });
    }
  }

  // 检查变化
  for (const [key, newItem] of newMap) {
    const oldItem = oldMap.get(key);
    if (oldItem) {
      const diffs = deepDiff(oldItem, newItem);
      if (diffs.length > 0) {
        changed.push({ key, diffs, old: oldItem, new: newItem });
      }
    }
  }

  const hasChanges = added.length > 0 || removed.length > 0 || changed.length > 0;

  let summary = '';
  if (hasChanges) {
    const parts = [];
    if (added.length > 0) parts.push(`新增 ${added.length} 项`);
    if (removed.length > 0) parts.push(`移除 ${removed.length} 项`);
    if (changed.length > 0) parts.push(`变更 ${changed.length} 项`);
    summary = parts.join('，');
  }

  return { hasChanges, added, removed, changed, summary };
}

/**
 * 深度对比两个对象，返回差异字段
 */
function deepDiff(oldObj, newObj, prefix = '') {
  const diffs = [];
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);

  for (const key of allKeys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];

    if (oldVal === undefined && newVal !== undefined) {
      diffs.push({ field: fullKey, old: undefined, new: newVal });
    } else if (oldVal !== undefined && newVal === undefined) {
      diffs.push({ field: fullKey, old: oldVal, new: undefined });
    } else if (typeof oldVal === 'object' && typeof newVal === 'object' && oldVal !== null && newVal !== null) {
      diffs.push(...deepDiff(oldVal, newVal, fullKey));
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({ field: fullKey, old: oldVal, new: newVal });
    }
  }
  return diffs;
}

/**
 * 读取当前数据文件
 * @param {string} dataDir - data/ 目录的绝对路径
 * @param {string} filename - 文件名
 * @returns {object}
 */
export function readDataFile(dataDir, filename) {
  const filepath = path.join(dataDir, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

/**
 * 写入数据文件
 * @param {string} dataDir
 * @param {string} filename
 * @param {object} data
 */
export function writeDataFile(dataDir, filename, data) {
  const filepath = path.join(dataDir, filename);
  // 备份旧版本
  if (fs.existsSync(filepath)) {
    const bak = path.join(dataDir, '.bak', filename.replace('.json', `.${dateStamp()}.json`));
    const bakDir = path.dirname(bak);
    if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true });
    fs.copyFileSync(filepath, bak);
  }
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 更新 metadata.json
 */
export function updateMetadata(dataDir, updates) {
  const meta = readDataFile(dataDir, 'metadata.json') || {};
  Object.assign(meta, updates, {
    generatedAt: new Date().toISOString(),
  });
  writeDataFile(dataDir, 'metadata.json', meta);
  return meta;
}

function dateStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
