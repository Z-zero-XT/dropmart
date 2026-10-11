'use strict';

/**
 * 交付适配器注册表
 * ---------------------------------------------------------------
 * 交付适配器负责回答两个问题：
 *   1. deliver(order, product, ctx) —— 这一单怎么把货交出去？
 *   2. stock(product, ctx)          —— 现在还剩多少？（-1 表示未知/不限）
 *
 * 适配器需要实现的接口（全部可选，但至少要有 deliver）：
 *
 *   module.exports = {
 *     name: 'your-adapter',
 *     async deliver(order, product, ctx) {
 *       // 返回 { ok: true,  items: ['交付内容', ...], message: '...' }
 *       //   或 { ok: false, manual: true, message: '转入人工处理' }
 *       //   或 { ok: false, message: '失败原因' }
 *     },
 *     stock(product, ctx) {
 *       // 返回剩余库存数量，-1 表示未知或不限
 *     },
 *     async importKeys(product, keys) {
 *       // 可选：后台批量导入卡密，返回 { imported, total }
 *     },
 *   };
 *
 * 新增适配器：在本文件底部 register() 一行即可。
 */

const registry = new Map();

function register(name, adapter) {
  if (!name || typeof name !== 'string') throw new Error('适配器必须有名字');
  if (!adapter || typeof adapter.deliver !== 'function') {
    throw new Error(`交付适配器 ${name} 必须实现 deliver()`);
  }
  registry.set(name, { name, stock: () => -1, ...adapter });
}

function get(name) {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(`未知的交付适配器 "${name}"，已注册：${[...registry.keys()].join(', ')}`);
  }
  return adapter;
}

function list() {
  return [...registry.keys()];
}

register('pool', require('./pool'));
register('upstream', require('./upstream'));
register('manual', require('./manual'));

module.exports = { get, list, register, registry };
