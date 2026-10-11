'use strict';

const deliveryAdapters = require('../adapters/delivery');
const paymentAdapters = require('../adapters/payment');
const { productsFile } = require('../config');
const { readJsonBody, sendError, sendJson } = require('../http');
const { badRequest, readJson, writeJsonAtomic } = require('../util');

function createAdminApi(services, auth) {
  const { site, store, orders } = services;

  function requireAdmin(ctx) {
    if (auth.verify(auth.bearer(ctx.req))) return true;
    sendError(ctx.res, 401, '未登录或会话已过期');
    return false;
  }

  function persistProduct(id, patch) {
    const file = productsFile();
    const raw = readJson(file, { products: [] });
    const list = Array.isArray(raw.products) ? raw.products : [];
    const target = list.find((item) => item && item.id === id);
    if (!target) return null;
    if (patch.price !== undefined) {
      const price = Number(patch.price);
      if (!Number.isFinite(price) || price < 0) throw badRequest('价格必须是非负数字');
      target.price = price;
    }
    if (patch.active !== undefined) target.active = Boolean(patch.active);
    if (patch.deliveryConfig !== undefined && patch.deliveryConfig !== null) {
      if (typeof patch.deliveryConfig !== 'object') throw badRequest('deliveryConfig 必须是对象');
      target.deliveryConfig = { ...(target.deliveryConfig || {}), ...patch.deliveryConfig };
    }
    writeJsonAtomic(file, raw);
    return target;
  }

  const lowStockThreshold = 5;

  return [
    {
      method: 'GET',
      pattern: '/api/admin/session',
      handler(ctx) {
        const token = auth.bearer(ctx.req);
        sendJson(ctx.res, 200, {
          ok: true,
          authenticated: auth.verify(token),
          insecureDefaultPassword: auth.insecureDefault,
        });
      },
    },

    {
      method: 'POST',
      pattern: '/api/admin/login',
      async handler(ctx) {
        const body = await readJsonBody(ctx.req);
        const token = auth.login(body.password);
        if (!token) return sendError(ctx.res, 401, '密码不正确');
        sendJson(ctx.res, 200, { ok: true, token, insecureDefaultPassword: auth.insecureDefault });
      },
    },

    {
      method: 'POST',
      pattern: '/api/admin/logout',
      async handler(ctx) {
        await readJsonBody(ctx.req);
        auth.logout(auth.bearer(ctx.req));
        sendJson(ctx.res, 200, { ok: true });
      },
    },

    {
      method: 'GET',
      pattern: '/api/admin/overview',
      handler(ctx) {
        if (!requireAdmin(ctx)) return;
        const catalog = orders.adminCatalog();
        sendJson(ctx.res, 200, {
          ok: true,
          site: {
            name: site.name,
            currency: site.currency,
            paymentDriver: site.payment.driver,
            paymentLabel: paymentAdapters.get(site.payment.driver).label(site),
            deliveryAdapters: deliveryAdapters.list(),
            paymentAdapters: paymentAdapters.list(),
          },
          stats: store.stats(),
          lowStock: catalog
            .filter((product) => product.active && product.stock >= 0 && product.stock <= lowStockThreshold)
            .map((product) => ({ id: product.id, title: product.title, stock: product.stock })),
          warnings: [
            auth.insecureDefault ? '管理后台仍在使用默认密码，请通过环境变量 ADMIN_PASSWORD 修改' : '',
            site.appSecretFromEnv ? '' : 'APP_SECRET 未设置，支付回调签名使用的是内置默认值',
            site.payment.driver === 'mock' ? '当前支付驱动是 mock（演示用），上线前请换成 manual 或 webhook' : '',
          ].filter(Boolean),
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/admin/orders',
      handler(ctx) {
        if (!requireAdmin(ctx)) return;
        const list = store.listOrders({
          status: ctx.url.searchParams.get('status') || '',
          productId: ctx.url.searchParams.get('productId') || '',
          keyword: ctx.url.searchParams.get('keyword') || '',
          limit: Number(ctx.url.searchParams.get('limit')) || 200,
        });
        sendJson(ctx.res, 200, { ok: true, orders: list.map((order) => orders.adminView(order)) });
      },
    },

    {
      method: 'GET',
      pattern: '/api/admin/orders/:id',
      handler(ctx) {
        if (!requireAdmin(ctx)) return;
        const order = orders.find(ctx.params.id);
        if (!order) return sendError(ctx.res, 404, '订单不存在');
        sendJson(ctx.res, 200, { ok: true, order: orders.adminView(order) });
      },
    },

    {
      method: 'POST',
      pattern: '/api/admin/orders/:id/paid',
      async handler(ctx) {
        if (!requireAdmin(ctx)) return;
        await readJsonBody(ctx.req);
        const order = await orders.markPaid(ctx.params.id, { driver: 'manual', ref: 'admin' });
        if (!order) return sendError(ctx.res, 404, '订单不存在');
        sendJson(ctx.res, 200, { ok: true, order: orders.adminView(order) });
      },
    },

    {
      method: 'POST',
      pattern: '/api/admin/orders/:id/fulfil',
      async handler(ctx) {
        if (!requireAdmin(ctx)) return;
        await readJsonBody(ctx.req);
        const order = await orders.fulfil(ctx.params.id);
        if (!order) return sendError(ctx.res, 404, '订单不存在');
        sendJson(ctx.res, 200, { ok: true, order: orders.adminView(order) });
      },
    },

    {
      method: 'POST',
      pattern: '/api/admin/orders/:id/deliver',
      async handler(ctx) {
        if (!requireAdmin(ctx)) return;
        const body = await readJsonBody(ctx.req);
        const order = await orders.deliverManually(ctx.params.id, body.items, body.note);
        sendJson(ctx.res, 200, { ok: true, order: orders.adminView(order) });
      },
    },

    {
      method: 'GET',
      pattern: '/api/admin/products',
      handler(ctx) {
        if (!requireAdmin(ctx)) return;
        sendJson(ctx.res, 200, {
          ok: true,
          currency: site.currency,
          products: orders.adminCatalog(),
          raw: readJson(productsFile(), { products: [] }).products || [],
        });
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/admin/products/:id',
      async handler(ctx) {
        if (!requireAdmin(ctx)) return;
        const body = await readJsonBody(ctx.req);
        const updated = persistProduct(ctx.params.id, {
          price: body.price,
          active: body.active,
          deliveryConfig: body.deliveryConfig,
        });
        if (!updated) return sendError(ctx.res, 404, '商品不存在');
        const list = services.reloadProducts();
        const found = list.find((product) => product.id === ctx.params.id);
        sendJson(ctx.res, 200, { ok: true, product: found ? orders.describe(found) : null });
      },
    },

    {
      method: 'POST',
      pattern: '/api/admin/products/:id/import',
      async handler(ctx) {
        if (!requireAdmin(ctx)) return;
        const body = await readJsonBody(ctx.req);
        const product = orders.findProduct(ctx.params.id);
        if (!product) return sendError(ctx.res, 404, '商品不存在');
        const adapter = deliveryAdapters.get(product.delivery);
        if (typeof adapter.importKeys !== 'function') {
          return sendError(ctx.res, 400, `交付适配器 ${product.delivery} 不支持导入卡密`);
        }
        const result = await adapter.importKeys(product, body.keys ?? '');
        sendJson(ctx.res, 200, { ok: true, result, product: orders.describe(product) });
      },
    },
  ];
}

module.exports = { createAdminApi };
