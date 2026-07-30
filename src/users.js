/**
 * 信差 - 用户管理
 * 订阅用户数据存储 + CRUD
 */

const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

const DEFAULT_PREFERENCES = {
  pushTime: '08:00',
  categories: ['AI-Agent', 'dev-tools', 'productivity', 'other'],
  maxItems: 10,
  pushEnabled: true,
};

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = USERS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(users, null, 2), 'utf-8');
  fs.renameSync(tmpFile, USERS_FILE);
}

/**
 * 注册/登录用户
 * @param {string} openid - 微信 openid
 * @param {object} userInfo - { nickName, avatarUrl }
 * @returns {object} 用户数据
 */
function registerOrLogin(openid, userInfo = {}) {
  if (!openid || typeof openid !== 'string') {
    throw new Error('缺少 openid');
  }

  const users = loadUsers();
  const now = new Date().toISOString();

  if (users[openid]) {
    // 更新最近登录
    users[openid].lastLogin = now;
    if (userInfo.nickName) users[openid].nickName = userInfo.nickName;
    if (userInfo.avatarUrl) users[openid].avatarUrl = userInfo.avatarUrl;
    saveUsers(users);
    return { ...users[openid], openid };
  }

  // 新用户
  const newUser = {
    nickName: userInfo.nickName || '用户',
    avatarUrl: userInfo.avatarUrl || '',
    subscribe: {
      status: 'inactive',      // inactive | subscribed | expired
      subscribeTmplId: '',      // 订阅模板 ID
      subscribeCount: 0,        // 已使用次数
      subscribeLimit: 3,        // 一次性订阅次数上限
      subscribedAt: '',
    },
    preferences: { ...DEFAULT_PREFERENCES },
    firstLogin: now,
    lastLogin: now,
    createdAt: now,
  };

  users[openid] = newUser;
  saveUsers(users);
  return { ...newUser, openid };
}

/**
 * 更新订阅状态
 * @param {string} openid
 * @param {string} tmplId - 微信模板 ID
 */
function updateSubscription(openid, tmplId) {
  const users = loadUsers();
  if (!users[openid]) throw new Error('用户不存在');

  users[openid].subscribe.status = 'subscribed';
  users[openid].subscribe.subscribeTmplId = tmplId;
  users[openid].subscribe.subscribeCount = 0;
  users[openid].subscribe.subscribedAt = new Date().toISOString();
  saveUsers(users);
  return { ...users[openid], openid };
}

/**
 * 更新偏好设置
 */
function updatePreferences(openid, prefs) {
  const users = loadUsers();
  if (!users[openid]) throw new Error('用户不存在');

  if (prefs.pushTime) users[openid].preferences.pushTime = prefs.pushTime;
  if (prefs.categories) users[openid].preferences.categories = prefs.categories;
  if (typeof prefs.maxItems === 'number') users[openid].preferences.maxItems = prefs.maxItems;
  if (typeof prefs.pushEnabled === 'boolean') users[openid].preferences.pushEnabled = prefs.pushEnabled;

  saveUsers(users);
  return { ...users[openid], openid };
}

/**
 * 消费一次订阅额度
 */
function consumeSubscription(openid) {
  const users = loadUsers();
  if (!users[openid]) throw new Error('用户不存在');
  users[openid].subscribe.subscribeCount++;
  if (users[openid].subscribe.subscribeCount >= users[openid].subscribe.subscribeLimit) {
    users[openid].subscribe.status = 'expired';
  }
  saveUsers(users);
}

/**
 * 获取所有已订阅用户
 */
function getSubscribedUsers() {
  const users = loadUsers();
  return Object.entries(users)
    .filter(([, u]) => u.subscribe.status === 'subscribed' && u.preferences.pushEnabled)
    .map(([openid, u]) => ({ openid, ...u }));
}

module.exports = {
  registerOrLogin,
  updateSubscription,
  updatePreferences,
  consumeSubscription,
  getSubscribedUsers,
};
