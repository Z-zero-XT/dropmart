'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, ROOT } = require('../../config');
const { ensureDir } = require('../../util');

const POOL_BASE = path.resolve(DATA_DIR, 'stock');

/**
 * 本地卡密池适配器
 * 配置：{ "file": "data/stock/your-pool.txt" }
 *
 * 池文件每行一个交付项，取货时从顶部取、取走的行会被真正删除。
 * 出于安全考虑，池文件被限制在 data/stock/ 目录内，
 * 这样即使有人改了配置也无法用它去读服务器上的任意文件。
 */
function resolvePoolFile(config = {}) {
  const raw = String(config.file || '').trim();
  if (!raw) throw new Error('pool 适配器缺少 deliveryConfig.file');
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
  if (resolved !== POOL_BASE && !resolved.startsWith(POOL_BASE + path.sep)) {
    throw new Error(`卡密池文件必须位于 data/stock/ 内，收到：${raw}`);
  }
  return resolved;
}

function readPool(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function writePool(file, lines) {
  ensureDir(path.dirname(file));
  const banner = '# 由 dropmart 自动维护。每行一个交付项，# 开头为注释。\n';
  fs.writeFileSync(file, banner + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

async function deliver(order, product) {
  const file = resolvePoolFile(product.deliveryConfig);
  const lines = readPool(file);
  if (lines.length < order.quantity) {
    return {
      ok: false,
      message: `库存不足：本单需要 ${order.quantity} 个，池内仅剩 ${lines.length} 个`,
    };
  }
  const items = lines.splice(0, order.quantity);
  writePool(file, lines);
  return { ok: true, items, message: `已从卡密池自动发货 ${items.length} 项` };
}

function stock(product) {
  return readPool(resolvePoolFile(product.deliveryConfig)).length;
}

async function importKeys(product, keys) {
  const file = resolvePoolFile(product.deliveryConfig);
  const existing = readPool(file);
  const incoming = (Array.isArray(keys) ? keys : String(keys).split(/\r?\n/))
    .map((line) => String(line).trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const before = existing.length;
  // 去重：已经在池里的不再重复导入
  const seen = new Set(existing);
  const additions = incoming.filter((line) => !seen.has(line));
  writePool(file, [...existing, ...additions]);
  return { imported: additions.length, skipped: incoming.length - additions.length, total: before + additions.length };
}

module.exports = { name: 'pool', deliver, importKeys, stock };
