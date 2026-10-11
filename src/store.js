'use strict';

const path = require('node:path');

const { DATA_DIR } = require('./config');
const { Mutex, readJson, writeJsonAtomic } = require('./util');

const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY_DB = { version: 1, orders: [] };

/**
 * 扁平文件存储。所有写操作都排队执行，保证单进程内的并发安全。
 * 订单量到几万条以上时，把 orders 换成一个真正的数据库即可，
 * 对外的接口（transact / listOrders 等）不用动。
 */
class Store {
  constructor(file = DB_FILE) {
    this.file = file;
    this.lock = new Mutex();
    this.db = readJson(file, EMPTY_DB);
    if (!Array.isArray(this.db.orders)) this.db.orders = [];
  }

  async persist() {
    writeJsonAtomic(this.file, this.db);
  }

  /** 所有会改动数据的操作都走这里，自动排队 + 落盘。 */
  transact(task) {
    return this.lock.run(async () => {
      const result = await task(this.db);
      await this.persist();
      return result;
    });
  }

  /** 只读操作可以直接调用，避免不必要的落盘。 */
  readOrder(id) {
    return this.db.orders.find((order) => order.id === id) || null;
  }

  listOrders({ status, productId, keyword, limit = 200 } = {}) {
    let list = [...this.db.orders];
    if (status) list = list.filter((order) => order.status === status);
    if (productId) list = list.filter((order) => order.productId === productId);
    if (keyword) {
      const needle = String(keyword).toLowerCase();
      list = list.filter((order) =>
        [order.id, order.productTitle, order.contact?.email, order.contact?.note]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle))
      );
    }
    return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  stats() {
    const settled = (order) =>
      order.status === 'paid' || order.status === 'delivered' || order.status === 'pending_manual';
    const orders = this.db.orders;
    return {
      totalOrders: orders.length,
      paidOrders: orders.filter(settled).length,
      deliveredOrders: orders.filter((order) => order.status === 'delivered').length,
      pendingManual: orders.filter((order) => order.status === 'pending_manual').length,
      pendingPayment: orders.filter((order) => order.status === 'pending').length,
      revenue: Number(
        orders
          .filter(settled)
          .reduce((sum, order) => sum + Number(order.amount || 0), 0)
          .toFixed(2)
      ),
    };
  }
}

module.exports = { Store };
