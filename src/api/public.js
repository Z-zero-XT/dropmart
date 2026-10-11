'use strict';

const deliveryAdapters = require('../adapters/delivery');
const paymentAdapters = require('../adapters/payment');
const { readJsonBody, sendError, sendJson } = require('../http');
const { STATUS_LABELS } = require('../orders');
const { safeEqual } = require('../util');

function createPublicApi(services) {
  const { site, orders } = services;

  return [
    {
      method: 'GET',
      pattern: '/api/health',
      handler(ctx) {
        sendJson(ctx.res, 200, {
          ok: true,
          name: site.name,
          uptimeSeconds: Math.round(process.uptime()),
          orders: services.store.db.orders.length,
          deliveryAdapters: deliveryAdapters.list(),
          paymentDriver: site.payment.driver,
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/site',
      handler(ctx) {
        sendJson(ctx.res, 200, {
          ok: true,
          site: {
            name: site.name,
            tagline: site.tagline,
            description: site.description,
            currency: site.currency,
            locale: site.locale,
            announcement: site.announcement,
            theme: site.theme,
            footer: site.footer,
            order: { maxQuantity: site.order.maxQuantity, expireMinutes: site.order.expireMinutes },
            payment: {
              driver: site.payment.driver,
              label: paymentAdapters.get(site.payment.driver).label(site),
            },
            statusLabels: STATUS_LABELS,
            deliveryAdapters: deliveryAdapters.list(),
            paymentAdapters: paymentAdapters.list(),
          },
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/products',
      handler(ctx) {
        sendJson(ctx.res, 200, {
          ok: true,
          currency: site.currency,
          products: orders.publicCatalog(),
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/products/:id',
      handler(ctx) {
        const product = orders.findProduct(ctx.params.id);
        if (!product || product.active === false) return sendError(ctx.res, 404, '商品不存在');
        sendJson(ctx.res, 200, { ok: true, product: orders.describe(product) });
      },
    },

    {
      method: 'POST',
      pattern: '/api/orders',
      async handler(ctx) {
        const body = await readJsonBody(ctx.req);
        const order = await orders.create({
          productId: body.productId,
          quantity: body.quantity,
          contact: body.contact,
        });
        sendJson(ctx.res, 201, {
          ok: true,
          token: order.token,
          order: orders.publicView(order),
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/orders/:id',
      handler(ctx) {
        const order = orders.find(ctx.params.id);
        if (!order) return sendError(ctx.res, 404, '订单不存在');
        const token = ctx.url.searchParams.get('token') || '';
        if (!safeEqual(order.token, token)) return sendError(ctx.res, 403, '查询凭证不正确');
        sendJson(ctx.res, 200, { ok: true, order: orders.publicView(order) });
      },
    },

    {
      method: 'POST',
      pattern: '/api/pay/webhook',
      async handler(ctx) {
        const payload = await readJsonBody(ctx.req);
        const adapter = paymentAdapters.get('webhook');
        const verdict = adapter.verifyCallback(payload, orders.ctx());
        if (!verdict.ok) return sendJson(ctx.res, 400, { ok: false, error: verdict.message });

        const order = orders.find(verdict.orderId);
        if (!order) return sendJson(ctx.res, 404, { ok: false, error: '订单不存在' });
        if (Number.isFinite(verdict.amount) && Math.abs(verdict.amount - order.amount) > 0.01) {
          return sendJson(ctx.res, 400, { ok: false, error: '回调金额与订单金额不一致' });
        }

        const updated = await orders.markPaid(order.id, { driver: 'webhook', ref: String(payload.tradeNo || payload.trade_no || '') });
        sendJson(ctx.res, 200, { ok: true, status: updated?.status || 'unknown' });
      },
    },
  ];
}

module.exports = { createPublicApi };
