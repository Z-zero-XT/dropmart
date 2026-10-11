'use strict';

const { orderToken, safeEqual } = require('./util');

/**
 * 极简管理员会话。会话存在内存里，重启即失效（对单机小店够用）。
 * 需要多实例部署时，把 sessions 换成 Redis 或数据库即可。
 */
class AdminAuth {
  constructor(password, ttlMs = 12 * 60 * 60 * 1000) {
    this.password = String(password ?? '');
    this.ttl = ttlMs;
    this.sessions = new Map();
  }

  get insecureDefault() {
    return this.password === 'admin' || this.password.length === 0;
  }

  login(password) {
    if (!safeEqual(String(password ?? ''), this.password)) return null;
    const token = orderToken() + orderToken();
    this.sessions.set(token, Date.now() + this.ttl);
    return token;
  }

  verify(token) {
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token) {
    return this.sessions.delete(token);
  }

  bearer(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1].trim() : '';
  }
}

module.exports = { AdminAuth };
