'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return clone(fallback);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${file}\n${err.message}`);
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? clone(base) : clone(override);
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      isPlainObject(value) && isPlainObject(base[key])
        ? deepMerge(base[key], value)
        : clone(value);
  }
  return out;
}

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function orderId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  return `DM${stamp}${randomCode(6)}`;
}

function orderToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(String(payload)).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function pickPath(source, dottedPath) {
  if (!dottedPath) return undefined;
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), source);
}

function maskEmail(value) {
  const text = String(value ?? '');
  const at = text.indexOf('@');
  if (at <= 1) return text;
  return `${text.slice(0, 2)}***${text.slice(at)}`;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function renderTemplate(template, vars) {
  if (typeof template === 'string') {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    );
  }
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, vars));
  if (isPlainObject(template)) {
    const out = {};
    for (const [key, value] of Object.entries(template)) out[key] = renderTemplate(value, vars);
    return out;
  }
  return template;
}

class Mutex {
  constructor() {
    this.chain = Promise.resolve();
  }

  run(task) {
    const result = this.chain.then(() => task());
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function badRequest(message) {
  return new HttpError(400, message);
}

module.exports = {
  HttpError,
  Mutex,
  badRequest,
  clone,
  deepMerge,
  ensureDir,
  hmacHex,
  isPlainObject,
  maskEmail,
  nowIso,
  orderId,
  orderToken,
  pickPath,
  randomCode,
  readJson,
  renderTemplate,
  round,
  safeEqual,
  writeJsonAtomic,
};
