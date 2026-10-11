'use strict';

const deliveryAdapters = require('./adapters/delivery');
const paymentAdapters = require('./adapters/payment');
const { badRequest, hmacHex, maskEmail, nowIso, orderId, orderToken, round } = require('./util');

const DELIVERY_LABELS = {
  pool: '自动发货',
  upstream: '上游直发',
  manual: '人工发货',
};

const STATUS_LABELS = {
  pending: '待支付',
  paid: '已支付',
  delivered: '已发货',
  pending_manual: '待人工发货',
  expired: '已超时',
  failed: '创建失败',
};

class OrderService {
  constructor({ store, site, products }) {
    this.store = store;
    this.site = site;
    this.products = products || [];
  }

  setProducts(products) {
    this.products = products || [];
  }

  ctx() {
    return { site: this.site, orders: this };
  }

  /* ------------------------------------------------------------ 商品 */

  findProduct(id) {
    return this.products.find((product) => product.id === id) || null;
  }

  requireProduct(id) {
    const product = this.findProduct(id);
    if (!product) throw badRequest('商品不存在');
    if (product.active === false) throw badRequest('该商品已下架');
    return product;
  }

  deliveryOf(product) {
    return deliveryAdapters.get(product.delivery);
  }

  payment() {
    return paymentAdapters.get(this.site.payment.driver);
  }

  stockOf(product) {
    try {
      const value = Number(this.deliveryOf(product).stock(product, this.ctx()));
      return Number.isFinite(value) ? value : -1;
    } catch {
      return 0;
    }
  }

  describe(product) {
    let stock = -1;
    let stockError = '';
    try {
      const value = Number(this.deliveryOf(product).stock(product, this.ctx()));
      stock = Number.isFinite(value) ? value : -1;
    } catch (err) {
      stock = 0;
      stockError = err.message;
    }
    return {
      id: product.id,
      title: product.title,
      subtitle: product.subtitle || '',
      price: round(product.price),
      currency: this.site.currency,
      tags: product.tags,
      sku: product.sku || product.id,
      delivery: product.delivery,
      deliveryLabel: DELIVERY_LABELS[product.delivery] || product.delivery,
      stock,
      stockError,
      available: product.active !== false && stock !== 0,
      active: product.active !== false,
    };
  }

  publicCatalog() {
    return this.products.filter((product) => product.active !== false).map((product) => this.describe(product));
  }

  adminCatalog() {
    return this.products.map((product) => this.describe(product));
  }

  /* ------------------------------------------------------------ 订单 */

  find(id) {
    return this.store.readOrder(id);
  }

  normalizeQuantity(value) {
    const quantity = Number.parseInt(value, 10);
    const max = Number(this.site.order?.maxQuantity) || 20;
    if (!Number.isFinite(quantity) || quantity < 1) throw badRequest('购买数量不正确');
    if (quantity > max) throw badRequest(`单笔最多购买 ${max} 件`);
    return quantity;
  }

  sanitizeContact(contact) {
    const source = contact && typeof contact === 'object' ? contact : {};
    const email = String(source.email ?? '').trim().slice(0, 120);
    const note = String(source.note ?? '').trim().slice(0, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('联系邮箱格式不正确');
    return { email, note };
  }

  async create({ productId, quantity, contact }) {
    const product = this.requireProduct(productId);
    const qty = this.normalizeQuantity(quantity);
    const buyer = this.sanitizeContact(contact);

    const order = await this.store.transact(async () => {
      const stock = this.stockOf(product);
      if (stock >= 0 && qty > stock) throw badRequest(`库存不足：当前仅剩 ${stock} 件`);
      const at = nowIso();
      const record = {
        id: orderId(),
        token: orderToken(),
        productId: product.id,
        sku: product.sku || product.id,
        productTitle: product.title,
        unitPrice: round(product.price),
        quantity: qty,
        amount: round(product.price * qty),
        currency: this.site.currency,
        contact: buyer,
        status: 'pending',
        deliveryType: product.delivery,
        items: [],
        message: '',
        payment: { driver: this.site.payment.driver, payUrl: null, label: '', manual: false, ref: '' },
        createdAt: at,
        updatedAt: at,
        events: [{ at, type: 'created', message: '订单已创建，等待支付' }],
      };
      this.store.db.orders.push(record);
      return record;
    });

    let result;
    try {
      result = await this.payment().createPayment(order, this.ctx());
    } catch (err) {
      result = { ok: false, message: `支付适配器异常：${err.message}` };
    }

    await this.store.transact(async () => {
      const target = this.store.readOrder(order.id);
      if (!target) return;
      const at = nowIso();
      target.updatedAt = at;
      target.payment = {
        ...target.payment,
        label: result.label || target.payment.label,
        payUrl: result.payUrl || null,
        manual: Boolean(result.manual),
      };
      if (result.message) {
        target.message = result.message;
        target.events.push({ at, type: 'payment', message: result.message });
      }
      if (result.ok === false) {
        target.status = 'failed';
        target.events.push({ at, type: 'failed', message: result.message || '创建支付失败' });
      }
    });

    return this.store.readOrder(order.id);
  }

  /** 标记为已付款并立即触发履约。支付回调、后台手动确认都走这里。 */
  async markPaid(id, meta = {}) {
    const exists = this.store.readOrder(id);
    if (!exists) return null;

    await this.store.transact(async () => {
      const target = this.store.readOrder(id);
      if (target.status === 'delivered' || target.status === 'pending_manual') return;
      const at = nowIso();
      target.status = 'paid';
      target.updatedAt = at;
      target.payment = {
        ...target.payment,
        driver: meta.driver || target.payment?.driver,
        ref: meta.ref || target.payment?.ref || '',
        paidAt: at,
      };
      target.events.push({
        at,
        type: 'paid',
        message: `已确认收款${meta.ref ? `（${meta.ref}）` : ''}`,
      });
    });

    return this.fulfil(id);
  }

  /** 执行履约：调用交付适配器，把结果写回订单。 */
  async fulfil(id) {
    const order = this.store.readOrder(id);
    if (!order) return null;
    if (order.status === 'delivered') return order;

    const product = this.findProduct(order.productId);
    if (!product) {
      await this.store.transact(async () => {
        const target = this.store.readOrder(id);
        const at = nowIso();
        target.status = 'paid';
        target.updatedAt = at;
        target.message = '商品配置已不存在，无法自动发货';
        target.events.push({ at, type: 'delivery_failed', message: target.message });
      });
      return this.store.readOrder(id);
    }

    let result;
    try {
      result = await this.deliveryOf(product).deliver(order, product, this.ctx());
    } catch (err) {
      result = { ok: false, message: `交付适配器异常：${err.message}` };
    }

    await this.store.transact(async () => {
      const target = this.store.readOrder(id);
      const at = nowIso();
      target.updatedAt = at;
      if (result.ok && Array.isArray(result.items) && result.items.length > 0) {
        target.items = result.items;
        target.status = 'delivered';
        target.deliveredAt = at;
        target.message = result.message || '已自动发货';
        target.events.push({ at, type: 'delivered', message: target.message });
      } else if (result.manual) {
        target.status = 'pending_manual';
        target.message = result.message || '已转入人工发货队列';
        target.events.push({ at, type: 'pending_manual', message: target.message });
      } else {
        target.status = 'paid';
        target.message = result.message || '自动发货失败，等待人工处理';
        target.events.push({ at, type: 'delivery_failed', message: target.message });
      }
    });

    const finalOrder = this.store.readOrder(id);
    if (finalOrder.status === 'delivered' || finalOrder.status === 'pending_manual') {
      void this.notify(finalOrder);
    }
    return finalOrder;
  }

  /** 管理员人工发货。 */
  async deliverManually(id, items, note) {
    const list = (Array.isArray(items) ? items : String(items || '').split(/\r?\n/))
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    if (list.length === 0) throw badRequest('交付内容不能为空');

    const updated = await this.store.transact(async () => {
      const target = this.store.readOrder(id);
      if (!target) throw badRequest('订单不存在');
      const at = nowIso();
      target.items = list;
      target.status = 'delivered';
      target.deliveredAt = at;
      target.updatedAt = at;
      target.message = note ? String(note).slice(0, 200) : '管理员已人工发货';
      target.events.push({ at, type: 'delivered', message: target.message });
      return target;
    });

    void this.notify(updated);
    return updated;
  }

  /** 把超过支付时限仍未付款的订单标记为已超时。 */
  async expireStale() {
    const minutes = Number(this.site.order?.expireMinutes) || 0;
    if (minutes <= 0) return 0;
    const deadline = Date.now() - minutes * 60 * 1000;
    const victims = this.store.db.orders.filter(
      (order) => order.status === 'pending' && new Date(order.createdAt).getTime() < deadline
    );
    if (victims.length === 0) return 0;
    await this.store.transact(async () => {
      const at = nowIso();
      for (const victim of victims) {
        const target = this.store.readOrder(victim.id);
        target.status = 'expired';
        target.updatedAt = at;
        target.events.push({ at, type: 'expired', message: `超过 ${minutes} 分钟未支付，订单已关闭` });
      }
    });
    return victims.length;
  }

  /* ------------------------------------------------------------ 通知外推 */

  async notify(order) {
    const url = this.site.delivery?.webhookNotifyUrl;
    if (!url) return false;
    const secret = this.site.delivery?.webhookNotifySecret || this.site.appSecret;
    const payload = JSON.stringify({
      event: order.status,
      orderId: order.id,
      productId: order.productId,
      quantity: order.quantity,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      contact: order.contact,
      items: order.items,
      at: nowIso(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dropmart-Signature': hmacHex(secret, payload),
        },
        body: payload,
        signal: controller.signal,
      });
      return response.ok;
    } catch (err) {
      console.warn(`[dropmart] 交付通知推送失败：${err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------ 视图 */

  publicView(order) {
    if (!order) return null;
    return {
      id: order.id,
      status: order.status,
      statusLabel: STATUS_LABELS[order.status] || order.status,
      productId: order.productId,
      productTitle: order.productTitle,
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      amount: order.amount,
      currency: order.currency,
      deliveryLabel: DELIVERY_LABELS[order.deliveryType] || order.deliveryType,
      message: order.message,
      contact: { email: maskEmail(order.contact?.email), note: order.contact?.note || '' },
      payment: {
        driver: order.payment?.driver,
        label: order.payment?.label,
        payUrl: order.payment?.payUrl || null,
        manual: Boolean(order.payment?.manual),
        paidAt: order.payment?.paidAt || null,
      },
      items: order.status === 'delivered' ? order.items : [],
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      deliveredAt: order.deliveredAt || null,
      events: (order.events || []).map(({ at, type, message }) => ({ at, type, message })),
    };
  }

  adminView(order) {
    return { ...order, statusLabel: STATUS_LABELS[order.status] || order.status };
  }
}

module.exports = { DELIVERY_LABELS, OrderService, STATUS_LABELS };
