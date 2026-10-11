'use strict';

/**
 * DropMart 冒烟测试（零依赖）
 *
 *   node scripts/smoke-test.js
 *
 * 做的事：
 *   1. 在系统临时目录里造一份隔离的 config + data
 *   2. 起一个假的「上游供货商」服务
 *   3. 用这份配置启动真实的 server.js
 *   4. 把三条交付链路（pool / upstream / manual）和三种支付回调全部跑一遍
 *   5. 清理现场，退出码反映结果
 *
 * 不会碰你项目里的 data/ 目录。
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const ADMIN_PASSWORD = 'smoke-test-password';
const WEBHOOK_SECRET = 'smoke-webhook-secret';

const results = [];
let base = '';

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function check(name, task) {
  try {
    await task();
    record(name, true);
  } catch (err) {
    record(name, false, err.message);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function req(pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: response.status, headers: response.headers, json, text };
}

function postJson(pathname, body, headers = {}) {
  return req(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

async function expectFailure(response, expectedStatus) {
  assert.equal(response.json?.ok, false, `期望失败，实际返回 ${response.status}：${response.text.slice(0, 200)}`);
  if (expectedStatus) assert.equal(response.status, expectedStatus, `期望 HTTP ${expectedStatus}，实际 ${response.status}`);
}

function sign(orderId, amount) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${orderId}:${amount}`).digest('hex');
}

function waitForHealth(deadlineMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) return resolve();
      } catch {
        /* 还没起来 */
      }
      if (Date.now() - started > deadlineMs) return reject(new Error('服务在 15 秒内没有就绪'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropmart-smoke-'));
  const configDir = path.join(workDir, 'config');
  const dataDir = path.join(workDir, 'data');
  const stockDir = path.join(dataDir, 'stock');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stockDir, { recursive: true });

  const poolFile = path.join(stockDir, 'pool.txt');
  fs.writeFileSync(poolFile, ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4', 'KEY-5'].join('\n') + '\n', 'utf8');

  // ---- 假的「上游供货商」 ----------------------------------------------
  const upstreamServer = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        /* 忽略 */
      }
      const quantity = Number(payload.quantity) || 1;
      const items = Array.from({ length: quantity }, (_, index) => `UPSTREAM-${payload.sku}-${index + 1}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { items, quantity } }));
    });
  });
  const upstreamPort = await freePort();
  await new Promise((resolve) => upstreamServer.listen(upstreamPort, '127.0.0.1', resolve));

  // ---- 隔离配置 ---------------------------------------------------------
  const siteConfig = {
    name: 'SmokeMart',
    tagline: '冒烟测试站点',
    currency: '¥',
    order: { expireMinutes: 30, maxQuantity: 20 },
    payment: {
      driver: 'mock',
      drivers: {
        mock: { label: '演示支付' },
        manual: { instruction: '请线下付款' },
        webhook: { gatewayUrl: 'https://gateway.test/pay', secret: WEBHOOK_SECRET },
      },
    },
    admin: { path: '/admin', password: 'should-be-overridden-by-env' },
  };
  fs.writeFileSync(path.join(configDir, 'site.json'), JSON.stringify(siteConfig, null, 2), 'utf8');

  const productsConfig = {
    products: [
      {
        id: 't-pool',
        title: '池发货商品',
        price: 10,
        active: true,
        delivery: 'pool',
        deliveryConfig: { file: poolFile },
        sku: 'T-POOL',
      },
      {
        id: 't-manual',
        title: '人工发货商品',
        price: 50,
        active: true,
        delivery: 'manual',
        deliveryConfig: { instruction: '人工处理中' },
        sku: 'T-MANUAL',
      },
      {
        id: 't-upstream',
        title: '上游发货商品',
        price: 30,
        active: true,
        delivery: 'upstream',
        deliveryConfig: {
          url: `http://127.0.0.1:${upstreamPort}/issue`,
          method: 'POST',
          body: { sku: '{{sku}}', quantity: '{{qty}}', reference: '{{orderId}}' },
          itemsPath: 'data.items',
          stock: 100,
        },
        sku: 'T-UP',
      },
      {
        id: 't-offline',
        title: '已下架商品',
        price: 1,
        active: false,
        delivery: 'manual',
        deliveryConfig: {},
        sku: 'T-OFF',
      },
    ],
  };
  fs.writeFileSync(path.join(configDir, 'products.json'), JSON.stringify(productsConfig, null, 2), 'utf8');

  // ---- 启动被测服务 -----------------------------------------------------
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: base,
      ADMIN_PASSWORD,
      APP_SECRET: 'smoke-app-secret',
      DROPMART_CONFIG_DIR: configDir,
      DROPMART_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childLog = '';
  child.stdout.on('data', (chunk) => {
    childLog += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    childLog += chunk.toString();
  });

  const cleanup = async () => {
    child.kill();
    await new Promise((resolve) => upstreamServer.close(resolve));
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  };

  try {
    await waitForHealth();
    console.log(`\n服务已就绪：${base}\n`);
  } catch (err) {
    console.error('启动失败：', err.message);
    console.error(childLog);
    await cleanup();
    process.exit(1);
  }

  const token = {}; // 存放跨用例共享的数据

  console.log('基础接口');

  await check('GET /api/health 返回 ok', async () => {
    const response = await req('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
  });

  await check('GET /api/site 暴露站点配置与适配器列表', async () => {
    const response = await req('/api/site');
    assert.equal(response.json.site.name, 'SmokeMart');
    assert.equal(response.json.site.payment.driver, 'mock');
    assert.deepEqual(response.json.site.deliveryAdapters, ['pool', 'upstream', 'manual']);
    assert.ok(!('appSecret' in response.json.site), '响应不应泄露 appSecret');
  });

  await check('GET /api/products 只返回上架商品并带库存', async () => {
    const response = await req('/api/products');
    const ids = response.json.products.map((product) => product.id);
    assert.deepEqual(ids.sort(), ['t-manual', 't-pool', 't-upstream']);
    const pool = response.json.products.find((product) => product.id === 't-pool');
    assert.equal(pool.stock, 5);
    assert.equal(pool.deliveryLabel, '自动发货');
  });

  await check('下架商品详情返回 404', async () => {
    const response = await req('/api/products/t-offline');
    await expectFailure(response, 404);
  });

  console.log('\n卡密池链路（pool）');

  await check('下单成功并返回支付链接与查询凭证', async () => {
    const response = await postJson('/api/orders', { productId: 't-pool', quantity: 2, contact: { email: 'buyer@example.com' } });
    assert.equal(response.status, 201);
    assert.equal(response.json.order.status, 'pending');
    assert.equal(response.json.order.amount, 20);
    assert.ok(response.json.order.payment.payUrl.includes('/api/pay/mock/'));
    assert.ok(response.json.token.length >= 32);
    assert.ok(response.json.order.contact.email.includes('***'), '订单视图里的邮箱应被打码');
    token.pool = { id: response.json.order.id, token: response.json.token };
  });

  await check('超过单笔上限被拒绝', async () => {
    const response = await postJson('/api/orders', { productId: 't-pool', quantity: 99 });
    await expectFailure(response, 400);
  });

  await check('库存不足被拒绝', async () => {
    const response = await postJson('/api/orders', { productId: 't-pool', quantity: 6 });
    await expectFailure(response, 400);
  });

  await check('错误的查询凭证返回 403', async () => {
    const response = await req(`/api/orders/${token.pool.id}?token=deadbeef`);
    await expectFailure(response, 403);
  });

  await check('未付款时订单不可见交付内容', async () => {
    const response = await req(`/api/orders/${token.pool.id}?token=${token.pool.token}`);
    assert.equal(response.json.order.status, 'pending');
    assert.deepEqual(response.json.order.items, []);
  });

  await check('走完演示支付会跳回订单页', async () => {
    const response = await req(`/api/pay/mock/${token.pool.id}?token=${token.pool.token}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.ok(response.headers.get('location').startsWith('/order.html?id='));
  });

  await check('支付后自动发货，交付内容正确', async () => {
    const response = await req(`/api/orders/${token.pool.id}?token=${token.pool.token}`);
    assert.equal(response.json.order.status, 'delivered');
    assert.deepEqual(response.json.order.items, ['KEY-1', 'KEY-2']);
  });

  await check('卡密池被真正扣减（5 → 3）', async () => {
    const response = await req('/api/products');
    const pool = response.json.products.find((product) => product.id === 't-pool');
    assert.equal(pool.stock, 3);
    const lines = fs.readFileSync(poolFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
    assert.deepEqual(lines, ['KEY-3', 'KEY-4', 'KEY-5']);
  });

  await check('重复支付是幂等的，不会重复发号', async () => {
    await req(`/api/pay/mock/${token.pool.id}?token=${token.pool.token}`, { redirect: 'manual' });
    const response = await req(`/api/orders/${token.pool.id}?token=${token.pool.token}`);
    assert.deepEqual(response.json.order.items, ['KEY-1', 'KEY-2']);
  });

  console.log('\n上游对接链路（upstream）');

  await check('上游商品下单并自动履约', async () => {
    const created = await postJson('/api/orders', { productId: 't-upstream', quantity: 3 });
    token.up = { id: created.json.order.id, token: created.json.token };
    await req(`/api/pay/mock/${token.up.id}?token=${token.up.token}`, { redirect: 'manual' });
    const response = await req(`/api/orders/${token.up.id}?token=${token.up.token}`);
    assert.equal(response.json.order.status, 'delivered');
    assert.deepEqual(response.json.order.items, ['UPSTREAM-T-UP-1', 'UPSTREAM-T-UP-2', 'UPSTREAM-T-UP-3']);
  });

  console.log('\n人工发货链路（manual）与管理后台');

  await check('人工商品付款后进入待发货队列', async () => {
    const created = await postJson('/api/orders', { productId: 't-manual', quantity: 1 });
    token.manual = { id: created.json.order.id, token: created.json.token };
    await req(`/api/pay/mock/${token.manual.id}?token=${token.manual.token}`, { redirect: 'manual' });
    const response = await req(`/api/orders/${token.manual.id}?token=${token.manual.token}`);
    assert.equal(response.json.order.status, 'pending_manual');
    assert.deepEqual(response.json.order.items, []);
  });

  await check('后台接口未登录时返回 401', async () => {
    const response = await req('/api/admin/orders');
    await expectFailure(response, 401);
  });

  await check('错误的管理密码被拒绝', async () => {
    const response = await postJson('/api/admin/login', { password: 'wrong-password' });
    await expectFailure(response, 401);
  });

  await check('正确密码换取后台会话', async () => {
    const response = await postJson('/api/admin/login', { password: ADMIN_PASSWORD });
    assert.equal(response.json.ok, true);
    token.admin = response.json.token;
  });

  const adminHeaders = () => ({ Authorization: `Bearer ${token.admin}` });

  await check('后台总览统计收入与待处理数量', async () => {
    const response = await req('/api/admin/overview', { headers: adminHeaders() });
    const stats = response.json.stats;
    assert.equal(stats.totalOrders, 3);
    assert.equal(stats.deliveredOrders, 2);
    assert.equal(stats.pendingManual, 1);
    assert.equal(stats.revenue, 20 + 90 + 50);
    assert.ok(response.json.warnings.length >= 1, '应提示仍在使用演示支付');
  });

  await check('后台可以按状态筛选订单', async () => {
    const response = await req('/api/admin/orders?status=pending_manual', { headers: adminHeaders() });
    assert.equal(response.json.orders.length, 1);
    assert.equal(response.json.orders[0].id, token.manual.id);
  });

  await check('管理员人工发货后顾客可取货', async () => {
    await postJson(`/api/admin/orders/${token.manual.id}/deliver`, { items: 'HAND-MADE-CODE', note: '人工发放' }, adminHeaders());
    const response = await req(`/api/orders/${token.manual.id}?token=${token.manual.token}`);
    assert.equal(response.json.order.status, 'delivered');
    assert.deepEqual(response.json.order.items, ['HAND-MADE-CODE']);
  });

  await check('后台导入卡密会去重', async () => {
    const response = await postJson('/api/admin/products/t-pool/import', { keys: 'KEY-3\nKEY-6\nKEY-7\n' }, adminHeaders());
    assert.equal(response.json.result.imported, 2);
    assert.equal(response.json.result.skipped, 1);
    assert.equal(response.json.product.stock, 5);
  });

  await check('后台改价生效', async () => {
    const response = await req('/api/admin/products/t-pool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify({ price: 12.5, active: true }),
    });
    assert.equal(response.json.product.price, 12.5);
  });

  console.log('\n通用支付网关（webhook）');

  await check('签名错误的回调被拒绝', async () => {
    const response = await postJson('/api/pay/webhook', {
      orderId: 'DM00000000XXXXXX',
      amount: 10,
      sign: 'not-a-real-signature',
    });
    await expectFailure(response, 400);
  });

  await check('金额对不上时回调被拒绝', async () => {
    const created = await postJson('/api/orders', { productId: 't-pool', quantity: 1 });
    const orderId = created.json.order.id;
    const response = await postJson('/api/pay/webhook', { orderId, amount: 0.01, sign: sign(orderId, 0.01) });
    await expectFailure(response, 400);
  });

  await check('签名正确的回调触发发货', async () => {
    const created = await postJson('/api/orders', { productId: 't-pool', quantity: 1 });
    const order = created.json.order;
    const response = await postJson('/api/pay/webhook', {
      orderId: order.id,
      amount: order.amount,
      sign: sign(order.id, order.amount),
    });
    assert.equal(response.json.ok, true);
    assert.equal(response.json.status, 'delivered');
    const queried = await req(`/api/orders/${order.id}?token=${created.json.token}`);
    assert.equal(queried.json.order.status, 'delivered');
    assert.equal(queried.json.order.items.length, 1);
  });

  console.log('\n静态页面');

  for (const [pathname, expected] of [['/', 'DropMart 前台首页'], ['/product.html', '商品详情页'], ['/order.html', '订单查询页'], ['/guide.html', '适配器指南'], ['/admin', '后台页面'], ['/styles.css', '样式表'], ['/app.js', '前端脚本']]) {
    await check(`GET ${pathname}（${expected}）`, async () => {
      const response = await req(pathname);
      assert.equal(response.status, 200, `HTTP ${response.status}`);
      assert.ok(response.text.length > 0);
    });
  }

  await check('目录穿越被拦截', async () => {
    const response = await req('/../package.json');
    assert.notEqual(response.status, 200);
  });

  await check('不存在的接口返回 404', async () => {
    const response = await req('/api/does-not-exist');
    await expectFailure(response, 404);
  });

  await cleanup();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${'='.repeat(56)}`);
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const item of failed) console.log(`  - ${item.name}\n    ${item.detail}`);
    console.log('\n服务端日志：\n' + childLog);
  }
  console.log('='.repeat(56));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试本身出错：', err);
  process.exit(1);
});
