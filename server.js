'use strict';

/**
 * DropMart —— 零依赖的中间商 / 自动交付商城骨架
 *
 *   node server.js
 *
 * 只要 Node 18+，不需要 npm install。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const deliveryAdapters = require('./src/adapters/delivery');
const paymentAdapters = require('./src/adapters/payment');
const { AdminAuth } = require('./src/admin-auth');
const { createAdminApi } = require('./src/api/admin');
const { createPublicApi } = require('./src/api/public');
const { PUBLIC_DIR, loadDotEnv, loadProducts, loadSite } = require('./src/config');
const { sendError, sendFile, sendJson } = require('./src/http');
const { OrderService } = require('./src/orders');
const { Store } = require('./src/store');
const { HttpError } = require('./src/util');

loadDotEnv();

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const site = loadSite();
site.publicUrl = (process.env.PUBLIC_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`).replace(/\/+$/, '');

const store = new Store();
const orders = new OrderService({ store, site, products: loadProducts() });
const auth = new AdminAuth(site.admin.password);

const services = {
  site,
  store,
  orders,
  reloadProducts: () => {
    const list = loadProducts();
    orders.setProducts(list);
    return list;
  },
};

const routes = [
  ...createPublicApi(services),
  ...createAdminApi(services, auth),
];

function matchRoute(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(':')) params[expected[i].slice(1)] = actual[i];
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}

function resolveStatic(pathname) {
  const adminPath = site.admin.path || '/admin';
  if (pathname === adminPath || pathname === `${adminPath}/`) {
    return path.join(PUBLIC_DIR, 'admin.html');
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const direct = path.resolve(PUBLIC_DIR, relative);
  if (direct !== PUBLIC_DIR && !direct.startsWith(PUBLIC_DIR + path.sep)) return null;
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(relative)) {
    const withHtml = `${direct}.html`;
    if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) return withHtml;
  }
  return null;
}

async function dispatchAdapterRoute(req, res, url, segments) {
  const driver = segments[2];
  const adapter = paymentAdapters.registry.get(driver);
  if (!adapter || typeof adapter.handleRequest !== 'function') return false;
  const params = segments.slice(3);
  const handled = await adapter.handleRequest({ req, res, url, params, ctx: orders.ctx() });
  return Boolean(handled);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    /* 保持原样 */
  }
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, POST, PATCH, OPTIONS' });
    res.end();
    return;
  }

  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] === 'api' && segments[1] === 'pay' && segments.length >= 4) {
    if (await dispatchAdapterRoute(req, res, url, segments)) return;
  }

  if (segments[0] === 'api') {
    for (const route of routes) {
      const params = matchRoute(route.pattern, pathname);
      if (!params) continue;
      if (route.method !== method) {
        sendError(res, 405, `该接口只支持 ${route.method}`);
        return;
      }
      await route.handler({ req, res, url, params, services, auth });
      return;
    }
    sendError(res, 404, `接口不存在：${method} ${pathname}`);
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendError(res, 405, '静态资源只支持 GET');
    return;
  }

  const file = resolveStatic(pathname);
  if (!file) {
    sendJson(res, 404, { ok: false, error: '页面不存在' });
    return;
  }
  sendFile(res, file);
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message);
        return;
      }
      console.error('[dropmart] 未处理的错误：', err);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误');
      else res.end();
    });
});

server.listen(PORT, HOST, () => {
  const lines = [
    '',
    `  ${site.name} 已启动`,
    `  前台      http://${HOST}:${PORT}/`,
    `  后台      http://${HOST}:${PORT}${site.admin.path}`,
    `  商品      ${orders.publicCatalog().length} 个在售`,
    `  支付驱动  ${site.payment.driver}（${paymentAdapters.get(site.payment.driver).label(site)}）`,
    `  交付适配  ${deliveryAdapters.list().join(' / ')}`,
  ];

  const warnings = [];
  if (auth.insecureDefault) warnings.push('管理后台正在使用默认密码，请设置环境变量 ADMIN_PASSWORD');
  if (site.payment.driver === 'mock') warnings.push('当前是演示支付（mock），任何人点开链接即算付款成功，请勿对公网开放');
  if (!site.appSecretFromEnv) warnings.push('未设置 APP_SECRET，支付回调签名使用内置默认值');

  if (warnings.length) {
    lines.push('');
    lines.push('  需要注意：');
    for (const warning of warnings) lines.push(`   ! ${warning}`);
  }
  lines.push('');
  console.log(lines.join('\n'));
});

setInterval(() => {
  orders.expireStale().catch((err) => console.error('[dropmart] 清理超时订单失败：', err.message));
}, 60_000).unref();

process.on('SIGINT', () => {
  console.log('\n[dropmart] 正在关闭…');
  server.close(() => process.exit(0));
});
