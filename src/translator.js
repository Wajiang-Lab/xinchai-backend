/**
 * 信差 - AI 翻译器
 * 使用 DeepSeek API 将英文日报翻译成中文
 * 兼容 OpenAI 格式，model 使用 deepseek-chat（性价比最高）
 */

const https = require('https');

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

/**
 * 翻译一批条目的标题和摘要
 * @param {Array} items - { title, summary } 对象数组
 * @param {string} apiKey - DeepSeek API Key
 * @returns {Array} 同结构数组，title/summary 被翻译
 */
async function translateItems(items, apiKey) {
  if (!apiKey || !items || items.length === 0) return items;

  const batchSize = 5;
  const results = [...items];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const prompts = batch.map((item, j) =>
      `[${i + j + 1}] 标题: ${item.title}\n摘要: ${(item.summary || '').slice(0, 150)}`
    ).join('\n---\n');

    const systemPrompt = '你是一个翻译助手。将以下英文技术新闻的「标题」和「摘要」翻译成中文。保持技术术语准确，保留专业名词不翻译（如 GitHub、Reddit、API、RSS、LLM、Agent 等）。按相同序号格式输出。';

    try {
      const translated = await callAI(systemPrompt, prompts, apiKey);
      if (translated) {
        const lines = translated.split('\n');
        let currentIdx = 0;
        for (const line of lines) {
          const match = line.match(/^\[(\d+)\]\s*(.*)/);
          if (match) {
            const idx = parseInt(match[1]) - 1;
            if (idx >= 0 && idx < results.length) {
              currentIdx = idx;
            }
            // 处理同一行里 [n] 后面的内容
            const rest = match[2] || '';
            if (rest.startsWith('标题:')) {
              results[currentIdx].title = rest.replace(/^标题:\s*/, '').trim();
            } else if (rest.startsWith('摘要:')) {
              results[currentIdx].summary = rest.replace(/^摘要:\s*/, '').trim();
            }
          } else if (line.startsWith('标题:') && currentIdx < results.length) {
            results[currentIdx].title = line.replace(/^标题:\s*/, '').trim();
          } else if (line.startsWith('摘要:') && currentIdx < results.length) {
            results[currentIdx].summary = line.replace(/^摘要:\s*/, '').trim();
          }
        }
      }
      console.log(`  ✅ DeepSeek 翻译: 第 ${i + 1}-${Math.min(i + batchSize, items.length)} 条`);
    } catch (err) {
      console.warn(`  ⚠️ 翻译失败: ${err.message}`);
    }

    // 每批等 1 秒
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}

function callAI(systemPrompt, userContent, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.choices?.[0]?.message?.content || '');
          } catch {
            reject(new Error('解析 API 响应失败'));
          }
        } else {
          reject(new Error(`API ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('API 超时')); });
    req.write(body);
    req.end();
  });
}

module.exports = { translateItems };
