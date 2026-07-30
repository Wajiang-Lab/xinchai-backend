# ============================================
# 信差 - 数据同步脚本
# 用法: node sync.js <JSON数据>
# 或配合自动化：把输出贴进这个脚本
# ============================================

const http = require('http');

const API_HOST = process.env.API_HOST || 'localhost';
const API_PORT = process.env.API_PORT || 3000;

/**
 * 将日报数据推送到后端
 * @param {Object} report - { date, dateLabel, items }
 */
function syncReport(report) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(report);

    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: '/api/reports',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const result = JSON.parse(body);
        console.log(`✅ 同步成功: ${report.date} (${report.items.length}条)`);
        resolve(result);
      });
    });

    req.on('error', (err) => {
      console.error('❌ 同步失败:', err.message);
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

// 命令行模式
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node sync.js \'{"date":"2026-07-28","items":[...]}\'');
    console.log('或者管道输入: echo \'{"date":"..."}\' | node sync.js');
    process.exit(1);
  }

  try {
    const report = JSON.parse(args.join(' '));
    syncReport(report).catch(() => process.exit(1));
  } catch (e) {
    console.error('JSON 解析失败:', e.message);
    process.exit(1);
  }
}

module.exports = { syncReport };
