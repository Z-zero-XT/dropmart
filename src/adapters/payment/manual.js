'use strict';

/**
 * 人工收款适配器
 * 下单后不给在线支付链接，只给一段说明；顾客线下付款后，
 * 管理员在后台把订单标记为已付款，随即触发履约。
 *
 * 适合刚开始没有支付资质、或者客单价较高需要人工确认的场景。
 */
function label(site) {
  return site.payment.drivers?.manual?.label || '人工收款';
}

async function createPayment(order, ctx) {
  const cfg = ctx.site.payment.drivers?.manual || {};
  return {
    ok: true,
    payUrl: null,
    manual: true,
    label: label(ctx.site),
    message: cfg.instruction || '请按客服提供的收款方式付款，付款后把订单号发给客服即可。',
  };
}

function verifyCallback() {
  return { ok: false, message: 'manual 适配器不使用异步回调，请在后台手动确认收款' };
}

module.exports = { name: 'manual', createPayment, label, verifyCallback };
