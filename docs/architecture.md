# 架构说明

这份文档写给想改代码的人。README 讲「怎么用」，这里讲「为什么这么写、怎么往下加」。

## 一、请求是怎么走完的

```
HTTP 请求
   │
   ├─ /api/pay/<driver>/...   ──► 适配器自定义路由（如 mock 的确认页）
   ├─ /api/*                  ──► 路由表（public.js / admin.js）
   └─ 其它                     ──► public/ 下的静态文件
```

路由表就是一个数组，每项是 `{ method, pattern, handler }`，`pattern` 支持 `:param`：

```js
{ method: 'GET', pattern: '/api/orders/:id', handler(ctx) { ... } }
```

`ctx` 里带着 `{ req, res, url, params, services, auth }`。`services` 是所有业务对象的集合：

```js
const services = { site, store, orders, reloadProducts };
```

新增一个接口 = 在 `src/api/public.js` 或 `src/api/admin.js` 的数组里加一项。没有中间件、
没有装饰器、没有依赖注入容器，因为不需要。

## 二、模块职责

| 文件 | 职责 | 不该做的事 |
| --- | --- | --- |
| `server.js` | 路由分发、静态资源、启动与优雅退出 | 不写业务逻辑 |
| `src/config.js` | 读取 `.env` 与 `config/*.json`，给出默认值 | 不校验业务规则 |
| `src/store.js` | JSON 读写、原子落盘、写锁 | 不认识「订单」的字段含义 |
| `src/orders.js` | 订单状态机、履约编排、视图转换 | 不直接发 HTTP |
| `src/adapters/*` | 与外部世界打交道 | 不碰订单存储 |
| `src/api/*` | HTTP 入参出参、鉴权 | 不写状态迁移逻辑 |

关键约定：**适配器不直接改订单**。适配器只返回结果，由 `orders.js` 写回状态。
这样任何适配器出问题时，订单数据仍然是自洽的。

## 三、交付适配器契约

```js
{
  name: string,

  // 必填。返回三种形态之一
  async deliver(order, product, ctx) {
    return { ok: true,  items: ['一行交付内容', ...], message: '说明' };
    return { ok: false, manual: true, message: '转入人工队列' };
    return { ok: false, message: '失败原因' };
  },

  // 可选。返回剩余库存，-1 表示未知或不限
  stock(product, ctx) { return -1; },

  // 可选。后台「导入卡密」按钮会调用它
  async importKeys(product, keys) {
    return { imported: 0, skipped: 0, total: 0 };
  },
}
```

要点：

- `deliver` **不要抛异常来表达业务失败**，返回 `{ ok: false, message }` 即可，上层会写成
  `paid` 状态并留下原因。抛异常会被兜底捕获，但错误信息会带上「适配器异常」前缀，不够干净。
- `manual: true` 是一个特殊信号，表示「这单不该自动完成」，订单会进入 `pending_manual`。
- `stock` 返回 `0` 会让前台显示「已售罄」，返回 `-1` 显示「由发货渠道实时决定」。
- `ctx` 目前是 `{ site, orders }`，方便适配器读取站点配置。不要用 `ctx.orders` 去改订单。

## 四、支付适配器契约

```js
{
  name: string,
  label(site) { return '前台显示的名字'; },

  // 必填
  async createPayment(order, ctx) {
    return { ok: true,  payUrl: 'https://...', label: '...' };
    return { ok: true,  payUrl: null, manual: true, message: '请线下付款' };
    return { ok: false, message: '配置有误' };
  },

  // 异步回调校验，POST /api/pay/webhook 会调用它
  verifyCallback(payload, ctx) {
    return { ok: true, orderId, amount };
  },

  // 可选。自定义路由，前缀 /api/pay/<name>/
  async handleRequest({ req, res, url, params, ctx }) { return false; },
}
```

`createPayment` 返回 `ok: false` 会把订单置为 `failed`；返回 `manual: true` 则订单保持 `pending`
并显示提示文案。`handleRequest` 返回 `true` 表示「这个请求我处理了」，返回 `false` 会继续走
后续路由。

## 五、存储

`data/db.json`：

```json
{
  "version": 1,
  "orders": [
    {
      "id": "DM20261011ABC123",
      "token": "<64 位 hex，订单查询凭证>",
      "productId": "demo-license",
      "productTitle": "示例软件授权码 · 1 个月",
      "unitPrice": 19.9,
      "quantity": 1,
      "amount": 19.9,
      "status": "delivered",
      "deliveryType": "pool",
      "items": ["DEMO-A1B2-C3D4-E5F6"],
      "contact": { "email": "...", "note": "" },
      "payment": { "driver": "mock", "ref": "MOCK-...", "paidAt": "..." },
      "events": [{ "at": "...", "type": "delivered", "message": "..." }],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

- **写操作一律走 `store.transact()`**，它内部用一条 Promise 链保证串行，写完立即原子落盘
  （先写临时文件再 `rename`）。
- **读操作直接用 `store.readOrder()`**，不落盘。
- `events` 是只增不改的审计线索，前台会把它渲染成订单轨迹。

### 换成真正的数据库

`Store` 对外只有这几个方法，替换掉即可：

```
transact(task)      串行执行一次写操作，task 收到 db 对象
persist()           落盘
readOrder(id)       按 id 查一条
listOrders(filter)  按状态 / 商品 / 关键词查多条
stats()             统计
```

注意 `orders.js` 里对 `store.db.orders` 有直接读写（在 `transact` 内部）。换成数据库时，
把这部分改成对应的查询即可，`orders.js` 之外的代码完全不用动。

## 六、常见扩展怎么做

**发货后发邮件通知顾客**
在 `orders.js` 的 `fulfil()` 末尾，状态为 `delivered` 的地方加一次调用。
`notify()` 已经示范了「不阻塞主流程」的写法（`void this.notify(...)`）。

**把订单同步到飞书 / 企业微信机器人**
配置 `delivery.webhookNotifyUrl` 指向你的中转地址即可，请求会带
`X-Dropmart-Signature: HMAC-SHA256(secret, body)`。

**加优惠券**
在 `OrderService.create()` 里改 `amount` 的计算方式，并在订单上记录 `discount` 字段。
前台在商品页加一个输入框，传给 `POST /api/orders`。状态机和适配器都不用动。

**支持多规格**
给商品的 `deliveryConfig` 加 `variants`，在 `requireProduct()` 里校验并算出真实单价。
`describe()` 返回给前台时带上规格列表。

**接入对象存储做交付内容托管**
写一个交付适配器，`deliver()` 里上传文件并返回带签名的下载链接。
注意链接不要直接暴露上游地址。

## 七、并发与一致性

单进程 Node 是单线程的，但异步 IO 会让「读-改-写」交错。因此：

- 库存校验和订单创建放在**同一个 `transact`** 里，避免超卖。
- 卡密池的读号 + 写回也在同一个同步块内完成（`pool.js` 里的 `deliver` 是同步操作）。
- `markPaid()` 是幂等的：已经是 `delivered` / `pending_manual` 的订单会直接返回，不会二次发号。
  支付网关重复回调不会导致重复发货。

**已知限制**：卡密池取号发生在付款之后，所以「两个顾客同时抢最后一件」时，后付款的那位会拿到
`库存不足` 的提示并停在 `paid` 状态，等你在后台处理。对单店来说这是可接受的；如果需要更强的一致性，
把库存预占（下单时锁定、超时释放）加到 `create()` 里。

## 八、前台

`public/app.js` 是单个文件，启动时读 `document.body.dataset.page` 分发到对应的渲染函数。
没有虚拟 DOM，用的是一个小工具函数：

```js
h('div', { class: 'panel' }, h('h2', { text: '标题' }))
```

主题在 `<head>` 里用一段内联脚本读取 `localStorage`，避免刷新时闪白。订单凭证存在
`localStorage`，所以顾客不用注册也能在「订单查询」页找回自己的单子。
