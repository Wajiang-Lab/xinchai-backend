/**
 * 信差后端配置
 * 读取环境变量，无 dotenv 依赖
 */
function loadConfig() {
  const fs = require('fs');
  const path = require('path');
  const envFile = path.join(__dirname, '..', '.env');

  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  return {
    WECHAT_SECRET: process.env.WECHAT_SECRET || '',
    PORT: parseInt(process.env.PORT || '3000', 10),
    ADMIN_KEY: process.env.ADMIN_KEY || 'xinchai-dev-key-change-me',
    DOUBAO_API_KEY: process.env.DOUBAO_API_KEY || '',
  };
}

module.exports = { loadConfig };
