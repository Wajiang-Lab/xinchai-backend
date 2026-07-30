const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const { loadConfig } = require('./config');
const config = loadConfig();

const obsidianWriter = require('./obsidian-writer');
const collector = require('./collector');
const users = require('./users');
const pusher = require('./pusher');

const app = express();
const PORT = config.PORT;
const DATA_FILE = path.join(__dirname, '..', 'data', 'reports.json');
const ADMIN_KEY = config.ADMIN_KEY;
const MAX_ITEMS = 50;
const MAX_REPORTS = 365;

// 安全中间件
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
}));
app.use(express.json({ limit: '1mb' }));

// 简易速率限制
const requestCounts = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_MAX = 30;
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, reset: now + RATE_WINDOW });
  } else {
    const entry = requestCounts.get(ip);
    if (now > entry.reset) {
      entry.count = 1;
      entry.reset = now + RATE_WINDOW;
    } else {
      entry.count++;
      if (entry.count > RATE_MAX) {
        return res.status(429).json({ error: '请求过于频繁' });
      }
    }
  }
  next();
});

// ============================================
// 数据存储（原子写入）
// ============================================

const writeLock = { locked: false, queue: [] };

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 原子写入：先写临时文件再 rename
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpFile, DATA_FILE);
}

function withLock(fn) {
  return new Promise((resolve, reject) => {
    const exec = async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        writeLock.locked = false;
        if (writeLock.queue.length > 0) {
          writeLock.locked = true;
          const next = writeLock.queue.shift();
          next();
        }
      }
    };
    if (writeLock.locked) {
      writeLock.queue.push(exec);
    } else {
      writeLock.locked = true;
      exec();
    }
  });
}

// ============================================
// 输入校验
// ============================================

function isValidDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime()) && d.getFullYear() >= 2020 && d.getFullYear() <= 2100;
}

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.length > 2048) return false;
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function sanitizeString(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return '';
  return str.slice(0, maxLen);
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.slice(0, MAX_ITEMS).map(item => ({
    id: typeof item.id === 'string' ? sanitizeString(item.id, 100) : `${Date.now()}-${uuidv4().slice(0, 8)}`,
    title: sanitizeString(item.title, 200),
    summary: sanitizeString(item.summary, 300),
    url: isValidUrl(item.url) ? item.url : '',
    category: ['AI-Agent', 'dev-tools', 'productivity', 'other'].includes(item.category)
      ? item.category : 'other',
    categoryLabel: sanitizeString(item.categoryLabel, 50) || '其他',
    source: sanitizeString(item.source, 100),
    time: sanitizeString(item.time, 20) || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  })).filter(item => item.title);
}

// 鉴权中间件
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: '无权限' });
  }
  next();
}

// ============================================
// API 路由
// ============================================

app.get('/api/reports', (req, res) => {
  const reports = loadData();
  res.json(reports);
});

app.get('/api/reports/latest', (req, res) => {
  const reports = loadData();
  if (reports.length === 0) return res.json(null);
  const sorted = [...reports].sort((a, b) => b.date.localeCompare(a.date));
  res.json(sorted[0]);
});

app.get('/api/reports/:date', (req, res) => {
  const date = req.params.date;
  if (!isValidDate(date)) return res.status(400).json({ error: '日期格式错误' });
  const reports = loadData();
  const report = reports.find(r => r.date === date);
  if (!report) return res.status(404).json({ error: '未找到该日报' });
  res.json(report);
});

app.get('/api/reports/item/:id', (req, res) => {
  const id = sanitizeString(req.params.id, 100);
  if (!id) return res.status(400).json({ error: '缺少 ID' });
  const reports = loadData();
  for (const report of reports) {
    const item = (report.items || []).find(i => i.id === id);
    if (item) return res.json(item);
  }
  res.status(404).json({ error: '未找到该情报' });
});

app.post('/api/reports', requireAdmin, async (req, res) => {
  const { date, dateLabel, items } = req.body;

  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'date 格式应为 YYYY-MM-DD' });
  }
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: '缺少 items 数组' });
  }

  const enrichedItems = validateItems(items);
  if (enrichedItems.length === 0) {
    return res.status(400).json({ error: 'items 为空或无有效条目' });
  }

  await withLock(async () => {
    const reports = loadData();
    const existingIdx = reports.findIndex(r => r.date === date);
    const newReport = {
      date,
      dateLabel: sanitizeString(dateLabel, 50) || formatDateLabel(date),
      items: enrichedItems
    };

    if (existingIdx >= 0) {
      reports[existingIdx] = newReport;
    } else {
      reports.push(newReport);
      // 超出上限删除最旧的
      if (reports.length > MAX_REPORTS) {
        reports.sort((a, b) => b.date.localeCompare(a.date));
        reports.splice(MAX_REPORTS);
      }
    }
    saveData(reports);

    try {
      obsidianWriter.writeReportToObsidian(newReport);
    } catch (err) {
      console.error('Obsidian 同步失败:', err.message);
    }
  });

  res.json({ success: true });
});

app.delete('/api/reports/:date', requireAdmin, (req, res) => {
  const date = req.params.date;
  if (!isValidDate(date)) return res.status(400).json({ error: '日期格式错误' });
  let reports = loadData();
  const before = reports.length;
  reports = reports.filter(r => r.date !== date);
  if (reports.length === before) {
    return res.status(404).json({ error: '未找到该日报' });
  }
  saveData(reports);
  res.json({ success: true });
});

// ============================================
// 管理接口
// ============================================

app.post('/api/admin/collect', requireAdmin, async (req, res) => {
  try {
    const digest = await collector.generateDailyDigest();
    await withLock(async () => {
      const reports = loadData();
      const existingIdx = reports.findIndex(r => r.date === digest.date);
      if (existingIdx >= 0) {
        reports[existingIdx] = digest;
      } else {
        reports.push(digest);
        if (reports.length > MAX_REPORTS) {
          reports.sort((a, b) => b.date.localeCompare(a.date));
          reports.splice(MAX_REPORTS);
        }
      }
      saveData(reports);
      try {
        obsidianWriter.writeReportToObsidian(digest);
      } catch (err) {
        console.error('Obsidian 同步失败:', err.message);
      }

      // 手动采集也触发推送（用于测试）
      try {
        const result = await pusher.pushDailyDigest(digest);
        console.log(`📬 推送统计: ${result.success} 成功 / ${result.failed} 失败`);
      } catch (err) {
        console.error('推送失败:', err.message);
      }
    });
    res.json({ success: true, count: digest.items.length });
  } catch (err) {
    console.error('采集失败:', err.message);
    res.status(500).json({ error: '采集失败' });
  }
});

app.get('/api/admin/status', requireAdmin, (req, res) => {
  const reports = loadData();
  const hasObsidian = fs.existsSync(
    path.join(__dirname, '..', '..', '信差情报库', '.obsidian')
  );
  res.json({
    reportsCount: reports.length,
    latestDate: reports.length > 0
      ? [...reports].sort((a, b) => b.date.localeCompare(a.date))[0].date
      : null,
    obsidianVault: hasObsidian,
  });
});

// ============================================
// 用户 & 订阅 API
// ============================================

// POST /api/user/login - 登录/注册
app.post('/api/user/login', (req, res) => {
  const { openid, nickName, avatarUrl } = req.body;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });
  try {
    const user = users.registerOrLogin(openid, { nickName, avatarUrl });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/user/subscribe - 更新订阅
app.post('/api/user/subscribe', (req, res) => {
  const { openid, tmplId } = req.body;
  if (!openid || !tmplId) return res.status(400).json({ error: '缺少参数' });
  try {
    const user = users.updateSubscription(openid, tmplId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/user/preferences - 更新偏好
app.post('/api/user/preferences', (req, res) => {
  const { openid, preferences } = req.body;
  if (!openid || !preferences) return res.status(400).json({ error: '缺少参数' });
  try {
    const user = users.updatePreferences(openid, preferences);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/profile - 获取用户信息
app.get('/api/user/profile', (req, res) => {
  const openid = req.query.openid;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });
  try {
    const user = users.registerOrLogin(openid);
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404（必须在所有路由之后）
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// ============================================
// 定时任务
// ============================================

cron.schedule('0 8 * * *', async () => {
  console.log('⏰ 定时采集 [08:00]');
  try {
    const digest = await collector.generateDailyDigest();
    await withLock(async () => {
      const reports = loadData();
      const existingIdx = reports.findIndex(r => r.date === digest.date);
      if (existingIdx >= 0) {
        reports[existingIdx] = digest;
      } else {
        reports.push(digest);
        if (reports.length > MAX_REPORTS) {
          reports.sort((a, b) => b.date.localeCompare(a.date));
          reports.splice(MAX_REPORTS);
        }
      }
      saveData(reports);
      try {
        obsidianWriter.writeReportToObsidian(digest);
      } catch (err) {
        console.error('Obsidian 同步失败:', err.message);
      }

      // 推送给已订阅用户
      try {
        await pusher.pushDailyDigest(digest);
      } catch (err) {
        console.error('推送失败:', err.message);
      }
    });
    console.log(`✅ 采集完成: ${digest.date} (${digest.items.length}条)`);
  } catch (err) {
    console.error('❌ 采集失败:', err.message);
  }
}, {
  scheduled: true,
  timezone: 'Asia/Shanghai'
});

// ============================================
// 工具函数
// ============================================

function formatDateLabel(dateStr) {
  const d = new Date(dateStr);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const w = weekdays[d.getDay()];
  return `${m}月${day}日 · ${w}`;
}

// ============================================
// 启动
// ============================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 信差 API: http://localhost:${PORT}`);
  console.log(`⏰ 定时采集: 每天 08:00 (北京时间)`);
});
