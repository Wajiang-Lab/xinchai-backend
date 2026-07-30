/**
 * 信差 - 推送调度器
 * 
 * 使用微信订阅消息推送日报
 * 模板ID: U_k9dqXOQT7kcqZelB2ynlg_h4uHcgwXv3jHkMlvUzY
 * 关键词: 日报名称 | 时间 | 备注
 */

const https = require('https');
const users = require('./users');

const WECHAT_APPID = 'wxaf78e12e9bd5eb02';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';

// access_token 缓存（有效期 7200 秒）
let tokenCache = { token: '', expireAt: 0 };

/**
 * 获取微信 access_token
 */
async function getAccessToken() {
  if (Date.now() < tokenCache.expireAt) {
    return tokenCache.token;
  }

  if (!WECHAT_SECRET) {
    console.log('⚠️ 未设置 WECHAT_SECRET，使用 Mock 模式推送');
    return '';
  }

  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.access_token) {
          tokenCache.token = result.access_token;
          tokenCache.expireAt = Date.now() + (result.expires_in - 60) * 1000;
          resolve(result.access_token);
        } else {
          reject(new Error(`获取 token 失败: ${result.errmsg}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * 发送订阅消息
 */
function sendMessage(openid, tmplId, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      touser: openid,
      template_id: tmplId,
      data,
      miniprogram_state: 'developer',  // developer | trial | formal
    });

    const req = https.request({
      hostname: 'api.weixin.qq.com',
      path: '/cgi-bin/message/subscribe/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.errcode === 0) {
            resolve(result);
          } else if (result.errcode === 43101) {
            reject(new Error('用户拒收'));
          } else {
            reject(new Error(`发送失败: ${result.errmsg}`));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  }).then(result => {
    // 拼接实际 URL（需要 access_token）
    return result;
  });
}

/**
 * 执行推送
 */
async function sendSubscribeMessage(openid, tmplId, report) {
  // 取 top 1 作为备注
  const topItem = (report.items || [])[0];
  const dateStr = report.dateLabel || new Date().toLocaleDateString('zh-CN');

  const data = {
    '日报名称': { value: '信差 · AI 情报日报' },
    '时间': { value: dateStr },
  };

  if (topItem) {
    data['备注'] = { value: topItem.title.slice(0, 60) };
  } else {
    data['备注'] = { value: '今日暂无新情报' };
  }

  const token = await getAccessToken();

  if (!token) {
    console.log(`📬 [Mock] 推送给 ${openid}: ${data['备注'].value}`);
    return { mock: true, success: true };
  }

  // 真实推送
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      touser: openid,
      template_id: tmplId,
      data,
      miniprogram_state: 'developer',
    });

    const options = {
      hostname: 'api.weixin.qq.com',
      path: `/cgi-bin/message/subscribe/send?access_token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(resData);
          if (result.errcode === 0) {
            console.log(`✅ 推送成功 ${openid}: ${data['备注'].value}`);
            resolve({ success: true });
          } else {
            console.warn(`⚠️ 推送失败 ${openid}: ${result.errmsg}`);
            reject(new Error(result.errmsg));
          }
        } catch {
          reject(new Error('解析响应失败'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 执行批量推送：遍历所有已订阅用户
 */
async function pushDailyDigest(report) {
  const subscribedUsers = users.getSubscribedUsers();
  console.log(`📬 开始推送: ${subscribedUsers.length} 个订阅用户`);

  let success = 0;
  let failed = 0;

  for (const user of subscribedUsers) {
    try {
      await sendSubscribeMessage(user.openid, user.subscribe.subscribeTmplId, report);
      users.consumeSubscription(user.openid);
      success++;
    } catch (err) {
      console.error(`❌ ${user.nickName || user.openid}: ${err.message}`);
      failed++;
    }
  }

  console.log(`📬 推送完成: ${success} 成功 / ${failed} 失败`);
  return { total: subscribedUsers.length, success, failed };
}

module.exports = { pushDailyDigest };
