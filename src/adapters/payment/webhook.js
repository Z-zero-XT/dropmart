'use strict';

const { hmacHex, safeEqual } = require('../../util');

/**
 * 通用支付网关适配器
 * 把任意支持「跳转支付 + 异步回调」的网关接进来。
 *
 * 配置：
 * {
 *   "gatewayUrl": "https://gateway.example.com/pay",
 *   "secret": "你的密钥（建议改用环境变量 APP_SECRET）",
 *   "label": "在线支付"
 * }
 *
 * 跳转时我们会带上这些参数：
 *   orderId / amount / currency / subject / notifyUrl / sign
 * 其中 sign = HMAC-SHA256(secret, `${orderId}:${amount}`)
 *
 * 网关回调 POST /api/pay/webhook 时需要回传同样字段，
 * 签名对得上、金额对得上，订单才会被标记为已付款。
 * 字段名做了常见别名兼容：orderId|order_id|out_trade_no，amount|money|total_fee。
 */

function config(ctx) {
  const cfg = ctx.site.payment.drivers?.webhook || {};
  return { ...cfg, secret: cfg.secret || ctx.site.appSecret };
}

function label(site) {
  return site.payment.drivers?.webhook?.label || '在线支付';
}

function signFor(secret, orderId, amount) {
  return hmacHex(secret, `${orderId}:${amount}`);
}

async function createPayment(order, ctx) {
  const cfg = config(ctx);
  if (!cfg.gatewayUrl) {
    return { ok: false, message: '未配置 payment.drivers.webhook.gatewayUrl' };
  }
  let url;
  try {
    url = new URL(cfg.gatewayUrl);
  } catch {
    return { ok: false, message: `gatewayUrl 不是合法的 URL：${cfg.gatewayUrl}` };
  }
  url.searchParams.set('orderId', order.id);
  url.searchParams.set('amount', order.amount);
  url.searchParams.set('currency', order.currency);
  url.searchParams.set('subject', order.productTitle);
  url.searchParams.set('notifyUrl', `${ctx.site.publicUrl}/api/pay/webhook`);
  url.searchParams.set('sign', signFor(cfg.secret, order.id, order.amount));
  return { ok: true, payUrl: url.toString(), label: label(ctx.site) };
}

function verifyCallback(payload, ctx) {
  const cfg = config(ctx);
  const orderId = payload.orderId ?? payload.order_id ?? payload.out_trade_no;
  const amount = payload.amount ?? payload.money ?? payload.total_fee;
  const sign = payload.sign ?? payload.signature;

  if (!orderId) return { ok: false, message: '回调缺少 orderId' };
  if (amount === undefined || amount === null || amount === '') {
    return { ok: false, message: '回调缺少 amount' };
  }
  if (!sign) return { ok: false, message: '回调缺少 sign' };

  if (!safeEqual(signFor(cfg.secret, orderId, amount), sign)) {
    return { ok: false, message: '回调签名校验失败' };
  }
  return { ok: true, orderId: String(orderId), amount: Number(amount) };
}

module.exports = { name: 'webhook', createPayment, label, verifyCallback };
