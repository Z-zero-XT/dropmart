'use strict';

const { pickPath, renderTemplate } = require('../../util');

/**
 * 上游对接适配器 —— 这是「中间商」模式的核心。
 *
 * 你把上游供应商的发货接口配进来，顾客在你店里下单、付钱，
 * 你的服务端替你去上游下单取货，再把结果回给顾客。
 *
 * 配置示例：
 * {
 *   "url": "https://supplier.example.com/api/issue",
 *   "method": "POST",
 *   "headers": { "Authorization": "Bearer TOKEN" },
 *   "body": { "sku": "{{sku}}", "quantity": "{{qty}}", "reference": "{{orderId}}" },
 *   "itemsPath": "data.items",
 *   "quantityField": "quantity",
 *   "itemField": "code",
 *   "timeoutMs": 10000,
 *   "stock": 500
 * }
 *
 * 占位符：{{qty}} {{orderId}} {{sku}} {{productId}}
 * itemsPath 支持点号路径，例如 data.items 或 result[0].keys（数组用下标即可）。
 */

const DEFAULT_TIMEOUT = 10000;

function buildVars(order, product) {
  return {
    qty: order.quantity,
    orderId: order.id,
    sku: product.sku || product.id,
    productId: product.id,
  };
}

function normalizeItems(value, itemField) {
  if (value === null || value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((item) => {
      if (item === null || item === undefined) return '';
      if (typeof item === 'string') return item;
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      if (itemField && typeof item === 'object' && item[itemField] !== undefined) {
        return String(item[itemField]);
      }
      return JSON.stringify(item);
    })
    .filter((item) => item.length > 0);
}

async function deliver(order, product) {
  const cfg = product.deliveryConfig || {};
  if (!cfg.url) {
    return { ok: false, manual: true, message: '上游未配置 url，已转入人工处理' };
  }

  const vars = buildVars(order, product);
  const method = String(cfg.method || 'POST').toUpperCase();
  const url = renderTemplate(String(cfg.url), vars);
  const headers = renderTemplate({ 'Content-Type': 'application/json', ...(cfg.headers || {}) }, vars);
  const sendsBody = method !== 'GET' && method !== 'HEAD';
  const body = sendsBody
    ? JSON.stringify(renderTemplate(cfg.body === undefined ? { sku: '{{sku}}', quantity: '{{qty}}' } : cfg.body, vars))
    : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();

    if (!response.ok) {
      return { ok: false, message: `上游返回 HTTP ${response.status}`, raw: text.slice(0, 500) };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, message: '上游返回的不是 JSON', raw: text.slice(0, 500) };
    }

    const items = normalizeItems(pickPath(payload, cfg.itemsPath || 'data.items'), cfg.itemField);
    if (items.length === 0) {
      return {
        ok: false,
        message: `上游未返回交付内容（itemsPath=${cfg.itemsPath || 'data.items'}）`,
        raw: JSON.stringify(payload).slice(0, 500),
      };
    }
    return { ok: true, items, message: `已由上游自动履约 ${items.length} 项` };
  } catch (err) {
    const reason = err.name === 'AbortError' ? '上游超时' : err.message;
    return { ok: false, message: `调用上游失败：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

function stock(product) {
  const declared = product?.deliveryConfig?.stock ?? product?.stock;
  const value = Number(declared);
  return Number.isFinite(value) ? value : -1;
}

module.exports = { name: 'upstream', deliver, stock };
