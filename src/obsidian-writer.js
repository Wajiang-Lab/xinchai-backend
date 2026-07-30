/**
 * 信差 - Obsidian 情报仓库写入模块
 * 把日报数据写成 Markdown 文件，存入 Obsidian 仓库
 */

const fs = require('fs');
const path = require('path');

const OBSIDIAN_VAULT = path.resolve(__dirname, '..', '..', '信差情报库');
const DAILY_DIR = path.join(OBSIDIAN_VAULT, '日报');
const ITEMS_DIR_BY_CATEGORY = {
  'AI-Agent': path.join(OBSIDIAN_VAULT, '情报', 'AI-Agent'),
  'dev-tools': path.join(OBSIDIAN_VAULT, '情报', '开发工具'),
  'productivity': path.join(OBSIDIAN_VAULT, '情报', '生产力工具'),
  'other': path.join(OBSIDIAN_VAULT, '情报', '其他关注'),
};

const CATEGORY_DIR_NAMES = {
  'AI-Agent': 'AI-Agent',
  'dev-tools': '开发工具',
  'productivity': '生产力工具',
  'other': '其他关注',
};

const CATEGORY_LABELS = {
  'AI-Agent': 'AI / 大模型',
  'dev-tools': '开发工具 / 新技术',
  'productivity': '生产力工具',
  'other': '其他关注',
};

const CATEGORY_TAGS = {
  'AI-Agent': ['AI', '大模型', 'Agent'],
  'dev-tools': ['开发工具', '前端', '编程'],
  'productivity': ['生产力', '笔记工具'],
  'other': ['情报'],
};

const VALID_CATEGORIES = Object.keys(ITEMS_DIR_BY_CATEGORY);

/**
 * 把一份日报写入 Obsidian 仓库
 * @param {Object} report - { date, dateLabel, items }
 */
function writeReportToObsidian(report) {
  const date = report.date;
  const dateLabel = report.dateLabel;
  const items = report.items;

  // 安全校验：date 必须是 YYYY-MM-DD 格式
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`非法日期: ${date}`);
  }

  const results = [];

  // 确保目录存在
  ensureDir(DAILY_DIR);
  for (const dir of Object.values(ITEMS_DIR_BY_CATEGORY)) {
    ensureDir(dir);
  }

  // 1. 写日报汇总笔记
  const dailyNote = buildDailyNote(date, dateLabel, items);
  const dailyFileName = sanitizeFilename(`${date}-日报`);
  const dailyFile = path.join(DAILY_DIR, `${dailyFileName}.md`);
  fs.writeFileSync(dailyFile, dailyNote, 'utf-8');
  results.push({ type: '日报', file: `${dailyFileName}.md` });
  console.log(`✅ Obsidian: 已写入日报 ${dailyFileName}.md`);

  // 2. 每条情报写成独立笔记
  for (const item of items) {
    const safeCat = VALID_CATEGORIES.includes(item.category) ? item.category : 'other';
    const catDir = ITEMS_DIR_BY_CATEGORY[safeCat];
    const safeTitle = sanitizeFilename(item.title);
    const itemFile = path.join(catDir, `${safeTitle}.md`);

    // 路径安全检查：确保文件在仓库内
    if (!isPathSafe(itemFile, OBSIDIAN_VAULT)) {
      console.warn(`⚠️ 跳过不安全路径: ${itemFile}`);
      continue;
    }

    if (!fs.existsSync(itemFile)) {
      const itemNote = buildItemNote(item, date);
      fs.writeFileSync(itemFile, itemNote, 'utf-8');
      results.push({ type: '情报', file: `${safeCat}/${safeTitle}.md` });
    }
  }

  // 3. 更新日报索引
  updateIndex(date, dateLabel, items);

  return results;
}

/**
 * 生成日报汇总笔记
 */
function buildDailyNote(date, dateLabel, items) {
  const weekday = getWeekday(date);

  const grouped = {};
  for (const item of items) {
    const cat = VALID_CATEGORIES.includes(item.category) ? item.category : 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  let md = '---\n';
  md += `title: "情报日报 ${escapeYaml(date)}"\n`;
  md += `date: ${escapeYaml(date)}\n`;
  md += `tags: [日报, 情报]\n`;
  md += `weekday: ${escapeYaml(weekday)}\n`;
  md += `total: ${items.length}\n`;
  md += '---\n\n';
  md += `# 📡 情报日报 | ${escapeMarkdown(dateLabel)}\n\n`;
  md += `> 共 ${items.length} 条情报\n\n`;

  for (const [cat, catItems] of Object.entries(grouped)) {
    const label = CATEGORY_LABELS[cat] || '其他';
    md += `## ${escapeMarkdown(label)}\n\n`;
    for (const item of catItems) {
      const safeTitle = sanitizeFilename(item.title);
      const dirName = CATEGORY_DIR_NAMES[cat] || '其他关注';
      const escapedTitle = escapeMarkdown(item.title);
      const escapedSummary = escapeMarkdown(item.summary || '');
      const link = item.url ? `[🔗 原文](${escapeMarkdown(item.url)})` : '';
      md += `- **[[情报/${dirName}/${safeTitle}|${escapedTitle}]]** — ${escapedSummary} ${link}\n`;
    }
    md += '\n';
  }

  md += '---\n';
  md += `*自动采集于 ${new Date().toLocaleString('zh-CN')}*\n`;

  return md;
}

/**
 * 生成单条情报笔记
 */
function buildItemNote(item, date) {
  const safeCat = VALID_CATEGORIES.includes(item.category) ? item.category : 'other';
  const tags = CATEGORY_TAGS[safeCat] || ['情报'];
  const catLabel = CATEGORY_LABELS[safeCat] || '其他';
  const safeTitle = sanitizeFilename(item.title);

  let md = '---\n';
  md += `title: "${escapeYaml(item.title || '未命名')}"\n`;
  md += `source_date: ${escapeYaml(date)}\n`;
  md += `category: "${escapeYaml(catLabel)}"\n`;
  md += `source_url: "${escapeYaml(item.url || '')}"\n`;
  md += `source: "${escapeYaml(item.source || '')}"\n`;
  md += `tags: [${tags.map(t => escapeYaml(t)).join(', ')}]\n`;
  md += '---\n\n';
  md += `# ${escapeMarkdown(item.title || '未命名情报')}\n\n`;
  md += `**${escapeMarkdown(item.summary || '')}**\n\n`;
  md += `- 🔗 [原文链接](${escapeMarkdown(item.url || '#')})\n`;
  md += `- 📅 来源日期: ${escapeYaml(date)}\n`;
  md += `- 📂 分类: ${escapeMarkdown(catLabel)}\n`;
  md += `- 📎 相关日报: [[${date}-日报|${date} 日报]]\n\n`;

  md += '---\n\n';
  md += '## 我的笔记\n\n';
  md += '> 在这里记录你的想法、实操体验、踩坑记录...\n\n';
  md += '- [ ] 动手试一遍\n';
  md += '- [ ] 记录踩坑点\n';
  md += '- [ ] 和其他知识做链接\n';

  return md;
}

/**
 * 更新日报索引
 */
function updateIndex(date, dateLabel, items) {
  const indexFile = path.join(DAILY_DIR, '日报索引.md');

  const counts = {};
  for (const item of items) {
    const label = CATEGORY_LABELS[item.category] || '其他';
    counts[label] = (counts[label] || 0) + 1;
  }
  const statStr = Object.entries(counts)
    .map(([k, v]) => `${escapeMarkdown(k)} ${v}条`)
    .join(' · ');

  const escapedDate = escapeMarkdown(date);
  const escapedLabel = escapeMarkdown(dateLabel);
  const entry = `| ${escapedDate} | [[${escapedDate}-日报\\|${escapedLabel}]] | ${items.length}条 | ${statStr} |\n`;

  let indexContent;
  if (fs.existsSync(indexFile)) {
    indexContent = fs.readFileSync(indexFile, 'utf-8');
    // 使用转义后的 date 构建安全的正则
    const escapedDateForRegex = escapedDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const datePattern = new RegExp(`^\\|\\s*${escapedDateForRegex}\\s*\\|.*\\|$`, 'm');
    if (datePattern.test(indexContent)) {
      indexContent = indexContent.replace(datePattern, entry.trim());
    } else {
      indexContent = indexContent.replace(
        /(\|.*\|.*\|.*\|.*\|\n)(\|?\s*-{3,}\s*\|)/,
        `$1${entry}$2`
      );
    }
  } else {
    indexContent = `# 📋 日报索引\n\n`;
    indexContent += `信差情报雷达的日报归档，按日期倒序排列。\n\n`;
    indexContent += `| 日期 | 日报 | 条目数 | 内容分布 |\n`;
    indexContent += `|------|------|--------|----------|\n`;
    indexContent += entry;
    indexContent += `| --- | --- | --- | --- |\n\n`;
    indexContent += `---\n\n`;
    indexContent += `> 🗺️ 查看全部情报 → [[情报/]]\n`;
  }

  fs.writeFileSync(indexFile, indexContent, 'utf-8');
  console.log(`✅ Obsidian: 已更新日报索引`);
}

// ============================================
// 工具函数
// ============================================

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isPathSafe(filePath, baseDir) {
  const resolved = path.resolve(filePath);
  const base = path.resolve(baseDir);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

function sanitizeFilename(title) {
  if (!title || typeof title !== 'string') return '未命名情报';
  return title
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/\.\./g, '·')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function escapeYaml(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .trim();
}

function escapeMarkdown(str) {
  if (!str) return '';
  return String(str)
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

function getWeekday(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '未知';
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return weekdays[d.getDay()];
}

module.exports = { writeReportToObsidian };
