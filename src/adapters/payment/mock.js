'use strict';

const { sendRedirect } = require('../../http');
const { safeEqual } = require('../../util');

/**
 * 演示支付适配器（默认）
 * 把用户带到 /api/pay/mock/<orderId> 点一下即视为付款成功。
 * 只用于本地开发和演示 —— 上线前请换成 manual 或 webhook。
 */
function label(site) {
  return site.payment.drivers?.mock?.label || '演示支付（即时到账）';
}

async function createPayment(order) {
  return {
    ok: true,
    payUrl: `/api/pay/mock/${encodeURIComponent(order.id)}?token=${encodeURIComponent(order.token)}`,
    label: '演示支付（即时到账）',
    message: '演示环境：点开支付链接即视为付款成功。',
  };
}

function verifyCallback() {
  return { ok: false, message: 'mock 适配器不使用异步回调' };
}

async function handleRequest({ res, url, params, ctx }) {
  const id = params[0];
  const order = id ? ctx.orders.find(id) : null;
  if (!order) {
    sendRedirect(res, '/order.html?error=not_found');
    return true;
  }
  const token = url.searchParams.get('token') || '';
  if (!safeEqual(order.token, token)) {
    sendRedirect(res, `/order.html?id=${encodeURIComponent(order.id)}&error=bad_token`);
    return true;
  }
  await ctx.orders.markPaid(order.id, { driver: 'mock', ref: `MOCK-${Date.now()}` });
  sendRedirect(res, `/order.html?id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.token)}`);
  return true;
}

module.exports = { name: 'mock', createPayment, handleRequest, label, verifyCallback };
