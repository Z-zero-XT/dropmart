'use strict';

/**
 * 支付适配器注册表
 * ---------------------------------------------------------------
 * 适配器接口：
 *
 *   module.exports = {
 *     name: 'your-gateway',
 *     label(site) { return '前台显示的名字'; },
 *
 *     // 创建订单后调用，返回支付跳转地址
 *     async createPayment(order, ctx) {
 *       // { ok: true, payUrl: 'https://...', label: '...' }
 *       // { ok: true, payUrl: null, manual: true, message: '请线下付款…' }
 *       // { ok: false, message: '配置有误' }
 *     },
 *
 *     // 网关异步回调时调用（POST /api/pay/<name>）
 *     verifyCallback(payload, ctx) {
 *       // { ok: true, orderId, amount } 或 { ok: false, message }
 *     },
 *
 *     // 可选：网关需要自己的路由（如同步跳回页），前缀是 /api/pay/<name>/...
 *     async handleRequest({ req, res, url, params, ctx }) { return true; },
 *   };
 *
 * ctx = { site, orders }，其中 orders 是 OrderService，可用
 * ctx.orders.markPaid(orderId, { driver, ref }) 完成履约。
 */

const registry = new Map();

function register(name, adapter) {
  if (!name || typeof name !== 'string') throw new Error('支付适配器必须有名字');
  if (typeof adapter.createPayment !== 'function') {
    throw new Error(`支付适配器 ${name} 必须实现 createPayment()`);
  }
  registry.set(name, {
    label: () => name,
    verifyCallback: () => ({ ok: false, message: `${name} 未实现回调校验` }),
    ...adapter,
  });
}

function get(name) {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(`未知的支付适配器 "${name}"，已注册：${[...registry.keys()].join(', ')}`);
  }
  return adapter;
}

function list() {
  return [...registry.keys()];
}

register('mock', require('./mock'));
register('manual', require('./manual'));
register('webhook', require('./webhook'));

module.exports = { get, list, register, registry };
