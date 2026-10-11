'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { deepMerge, readJson } = require('./util');

const ROOT = path.resolve(__dirname, '..');
// 配置目录与数据目录都可以用环境变量改写，方便测试隔离、多站点部署与容器挂载
const CONFIG_DIR = process.env.DROPMART_CONFIG_DIR
  ? path.resolve(process.env.DROPMART_CONFIG_DIR)
  : path.join(ROOT, 'config');
const DATA_DIR = process.env.DROPMART_DATA_DIR
  ? path.resolve(process.env.DROPMART_DATA_DIR)
  : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULT_SITE = {
  name: 'DropMart',
  tagline: '',
  description: '',
  currency: '¥',
  locale: 'zh-CN',
  announcement: '',
  theme: { accent: '#0071e3', defaultMode: 'dark' },
  footer: { text: '', links: [] },
  order: { expireMinutes: 30, maxQuantity: 20 },
  payment: { driver: 'mock', drivers: {} },
  delivery: { webhookNotifyUrl: '', webhookNotifySecret: '' },
  admin: { path: '/admin', password: 'admin' },
};

/**
 * 极简 .env 读取（零依赖）。只在文件存在时生效，不覆盖已存在的环境变量。
 */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadSite() {
  const raw = readJson(path.join(CONFIG_DIR, 'site.json'), {});
  const site = deepMerge(DEFAULT_SITE, raw);
  site.admin.password = process.env.ADMIN_PASSWORD || raw.admin?.password || 'admin';
  site.admin.passwordFromEnv = Boolean(process.env.ADMIN_PASSWORD);
  site.appSecret =
    process.env.APP_SECRET ||
    raw.appSecret ||
    'dropmart-dev-secret-not-for-production';
  site.appSecretFromEnv = Boolean(process.env.APP_SECRET);
  return site;
}

function loadProducts() {
  const raw = readJson(path.join(CONFIG_DIR, 'products.json'), { products: [] });
  const list = Array.isArray(raw.products) ? raw.products : [];
  return list
    .filter((item) => item && typeof item.id === 'string' && item.id.length > 0)
    .map((item) => ({
      ...item,
      price: Number(item.price) || 0,
      active: item.active !== false,
      tags: Array.isArray(item.tags) ? item.tags : [],
      delivery: item.delivery || 'manual',
      deliveryConfig: item.deliveryConfig || {},
    }));
}

function productsFile() {
  return path.join(CONFIG_DIR, 'products.json');
}

module.exports = {
  CONFIG_DIR,
  DATA_DIR,
  PUBLIC_DIR,
  ROOT,
  loadDotEnv,
  loadProducts,
  loadSite,
  productsFile,
};
