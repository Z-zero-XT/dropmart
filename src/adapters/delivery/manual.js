'use strict';

/**
 * 人工发货适配器
 * 配置：{ "instruction": "给顾客看的说明", "stock": 100 }
 *
 * 付款成功后订单会进入「待人工发货」队列，管理员在后台填入交付内容即可完成。
 * 适合低频、需要人工核对、或者上游暂时没有 API 的商品。
 */
async function deliver(order, product) {
  return {
    ok: false,
    manual: true,
    message: product.deliveryConfig?.instruction || '已付款，管理员会尽快人工发货',
  };
}

function stock(product) {
  const value = Number(product?.deliveryConfig?.stock);
  return Number.isFinite(value) ? value : -1;
}

module.exports = { name: 'manual', deliver, stock };
