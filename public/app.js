/* ==========================================================================
   DropMart 前端逻辑
   单文件、无构建、无依赖。每个页面在 <body data-page="..."> 上声明自己是谁，
   本文件启动时按这个值分发。
   ========================================================================== */

const THEME_KEY = 'dropmart-theme';
const TOKEN_KEY = 'dropmart-admin-token';
const ORDERS_KEY = 'dropmart-orders';

const state = {
  site: null,
  currency: '¥',
  maxQuantity: 20,
  adminToken: '',
  adminOrderFilter: '',
};

/* ------------------------------------------------------------------ 小工具 */

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function money(value) {
  const num = Number(value) || 0;
  const text = Number.isInteger(num) ? String(num) : num.toFixed(2);
  return `${state.currency}${text}`;
}

function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = h('div', { class: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制');
    } catch {
      toast('复制失败，请手动选择');
    }
    area.remove();
  }
}

/* ------------------------------------------------------------------ API */

async function request(method, path, body, { admin = false } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (admin && state.adminToken) options.headers.Authorization = `Bearer ${state.adminToken}`;
  const response = await fetch(path, options);
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* 忽略非 JSON 响应 */
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  adminGet: (path) => request('GET', path, undefined, { admin: true }),
  adminPost: (path, body) => request('POST', path, body ?? {}, { admin: true }),
  adminPatch: (path, body) => request('PATCH', path, body ?? {}, { admin: true }),
};

/* ------------------------------------------------------------------ 主题 */

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* 无痕模式下忽略 */
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}

const SUN_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M5.6 5.6 4 4M20 20l-1.6-1.6M18.4 5.6 20 4M4 20l1.6-1.6"/></svg>';
const MOON_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/></svg>';

/* ------------------------------------------------------------------ 外壳 */

function renderShell() {
  const site = state.site || {};
  document.title = document.body.dataset.title
    ? `${document.body.dataset.title} · ${site.name || 'DropMart'}`
    : site.name || 'DropMart';
  if (site.theme?.accent) {
    document.documentElement.style.setProperty('--accent', site.theme.accent);
  }

  const header = document.querySelector('header.site');
  if (header) {
    const nav = h('nav', { class: 'nav' });
    nav.append(
      h('a', { href: '/', text: '全部商品' }),
      h('a', { href: '/order.html', text: '订单查询' }),
      h(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          title: '切换主题',
          'aria-label': '切换主题',
          onclick: () => {
            toggleTheme();
            syncThemeButton();
          },
        },
        h('span', { class: 'theme-slot' })
      )
    );

    const bar = h('div', { class: 'bar wrap' });
    bar.append(
      h(
        'a',
        { class: 'brand', href: '/', style: 'text-decoration:none' },
        h('span', { class: 'name', text: site.name || 'DropMart' })
      ),
      h('span', { class: 'spacer' }),
      nav
    );
    clear(header).append(bar);
    syncThemeButton();
  }

  const footer = document.querySelector('footer.site');
  if (footer) {
    const row = h('div', { class: 'row' });
    row.append(h('span', { text: site.footer?.text || site.name || 'DropMart' }));
    for (const link of site.footer?.links || []) {
      row.append(h('a', { href: link.href, text: link.label }));
    }
    const adminPath = site.adminPath || '/admin';
    row.append(h('span', { class: 'spacer' }), h('a', { href: adminPath, text: '管理后台' }));
    clear(footer).append(h('div', { class: 'wrap' }, row));
  }
}

function syncThemeButton() {
  const slot = document.querySelector('.theme-slot');
  if (!slot) return;
  slot.innerHTML = document.documentElement.dataset.theme === 'dark' ? SUN_ICON : MOON_ICON;
}

/* ------------------------------------------------------------------ 本机订单 */

function loadLocalOrders() {
  try {
    const list = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberOrder(order, token) {
  const list = loadLocalOrders().filter((item) => item.id !== order.id);
  list.unshift({
    id: order.id,
    token,
    title: order.productTitle,
    status: order.status,
    at: order.createdAt,
  });
  try {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    /* 忽略配额错误 */
  }
}

/* ------------------------------------------------------------------ 商品卡 */

function statusBadge(status, label) {
  return h('span', { class: `badge ${status}`, text: label || status });
}

function productCard(product, { href } = {}) {
  const soldOut = product.stock === 0;
  const card = h('article', { class: `product${soldOut ? ' sold-out' : ''}` });

  const tags = h('div', { class: 'tags' });
  for (const tag of product.tags || []) tags.append(h('span', { class: 'badge', text: tag }));

  card.append(
    tags,
    href
      ? h('a', { class: 'title', href, text: product.title, style: 'color:inherit' })
      : h('div', { class: 'title', text: product.title }),
    product.subtitle ? h('p', { class: 'sub', text: product.subtitle }) : h('p', { class: 'sub' })
  );

  const stockLine = soldOut
    ? '已售罄'
    : product.stock > 0
      ? `剩余 ${product.stock} 件`
      : product.delivery === 'manual'
        ? '人工发货'
        : '库存充足';
  if (product.stockError) {
    card.querySelector('.sub').textContent = `配置有误：${product.stockError}`;
  }

  const foot = h('div', { class: 'foot' });
  const left = h(
    'div',
    null,
    h(
      'div',
      { class: 'price' },
      h('span', { class: 'cur', text: state.currency }),
      String(product.price)
    ),
    h('div', { class: 'stock-line', text: stockLine })
  );
  const action = soldOut
    ? h('button', { class: 'btn small', type: 'button', disabled: true, text: '已售罄' })
    : h('a', { class: 'btn small', href, text: '购买', style: 'text-decoration:none' });

  foot.append(left, action);
  card.append(foot);
  return card;
}

/* ------------------------------------------------------------------ 页面：首页 */

async function pageCatalog() {
  const mount = document.getElementById('mount');
  const data = await api.get('/api/products');
  const site = state.site || {};

  clear(mount).append(
    h(
      'section',
      { class: 'hero' },
      h('h1', { text: site.tagline || '全部商品' }),
      site.description ? h('p', { text: site.description }) : null
    )
  );

  if (site.announcement) {
    mount.append(h('div', { class: 'alert announce', text: site.announcement }));
  }

  if (!data.products.length) {
    mount.append(
      h(
        'div',
        { class: 'card empty' },
        '还没有上架任何商品，编辑 config/products.json 就能加。'
      )
    );
    return;
  }

  const grid = h('div', { class: 'grid' });
  for (const product of data.products) {
    grid.append(productCard(product, { href: `/product.html?id=${encodeURIComponent(product.id)}` }));
  }
  mount.append(grid);
}

/* ------------------------------------------------------------------ 页面：商品详情 */

async function pageProduct() {
  const mount = document.getElementById('mount');
  const id = new URLSearchParams(location.search).get('id') || '';
  if (!id) {
    mount.append(h('div', { class: 'card empty' }, '缺少商品参数。', h('br'), h('a', { href: '/', text: '返回全部商品' })));
    return;
  }

  let product;
  try {
    product = (await api.get(`/api/products/${encodeURIComponent(id)}`)).product;
  } catch (err) {
    mount.append(h('div', { class: 'card empty' }, err.message));
    return;
  }

  document.title = `${product.title} · ${state.site?.name || 'DropMart'}`;

  const soldOut = product.stock === 0;
  const stockText = soldOut
    ? '当前已售罄'
    : product.stock > 0
      ? `剩余 ${product.stock} 件`
      : product.delivery === 'manual'
        ? '人工发货，不限库存'
        : '由发货渠道实时决定';
  const maxQty = soldOut ? 1 : product.stock > 0 ? Math.min(product.stock, state.maxQuantity) : state.maxQuantity;

  const emailInput = h('input', { class: 'input', type: 'email', placeholder: '接收交付内容的邮箱（可选）' });
  const noteInput = h('input', { class: 'input', type: 'text', placeholder: '备注（可选）' });
  const qtyInput = h('input', { class: 'input', type: 'number', min: '1', max: String(maxQty), value: '1' });

  const submit = h('button', {
    class: 'btn',
    type: 'submit',
    text: `立即购买 · ${money(product.price)}`,
    style: 'width:100%',
    disabled: soldOut,
  });

  const form = h(
    'form',
    {
      class: 'panel',
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        submit.textContent = '处理中…';
        try {
          const created = await api.post('/api/orders', {
            productId: product.id,
            quantity: Number(qtyInput.value),
            contact: { email: emailInput.value.trim(), note: noteInput.value.trim() },
          });
          rememberOrder(created.order, created.token);
          if (created.order.payment.payUrl) {
            location.href = created.order.payment.payUrl;
            return;
          }
          location.href = `/order.html?id=${encodeURIComponent(created.order.id)}&token=${encodeURIComponent(created.token)}`;
        } catch (err) {
          toast(err.message);
          submit.disabled = false;
          submit.textContent = `立即购买 · ${money(product.price)}`;
        }
      },
    },
    h('h2', { text: '填写购买信息' }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '数量' }), qtyInput),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '联系邮箱' }), emailInput),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '备注' }), noteInput),
    submit,
    h('p', {
      class: 'note',
      style: 'margin-top:10px',
      text: `支付方式：${state.site?.payment?.label || '—'}。下单后会生成本单专属的查询链接。`,
    })
  );

  const detail = h(
    'div',
    null,
    product.tags?.length
      ? h('div', { class: 'tags', style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px' },
          ...product.tags.map((tag) => h('span', { class: 'badge', text: tag })))
      : null,
    h('h1', { text: product.title, style: 'margin-bottom:10px' }),
    product.subtitle ? h('p', { text: product.subtitle, style: 'color:var(--muted)' }) : null,
    h(
      'div',
      { class: 'panel', style: 'margin-top:18px' },
      h('h3', { text: '发货信息' }),
      h(
        'dl',
        { class: 'kv', style: 'margin-top:12px' },
        h('dt', { text: '商品编号' }), h('dd', { class: 'mono', text: product.sku }),
        h('dt', { text: '发货方式' }), h('dd', { text: product.deliveryLabel }),
        h('dt', { text: '库存' }), h('dd', { text: product.stockError || stockText }),
        h('dt', { text: '支付方式' }), h('dd', { text: state.site?.payment?.label || '—' })
      )
    )
  );

  clear(mount).append(
    h('div', { class: 'two-col' }, h('div', null, detail), form),
    h('p', { style: 'margin-top:20px' }, h('a', { href: '/', text: '返回全部商品' }))
  );
}

/* ------------------------------------------------------------------ 页面：订单 */

function orderStatusBlock(order) {
  const wrap = h('div', { class: 'stack' });

  wrap.append(
    h(
      'div',
      { class: 'row-flex' },
      statusBadge(order.status, order.statusLabel),
      h('span', { class: 'note', text: `下单时间 ${shortTime(order.createdAt)}` })
    )
  );

  if (order.message) wrap.append(h('div', { class: 'alert info', text: order.message }));

  if (order.status === 'delivered' && order.items.length) {
    const box = h(
      'div',
      { class: 'delivery-box' },
      h('div', { class: 'row-flex' }, h('strong', { text: '交付内容' }), h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: '复制全部',
          onclick: () => copyText(order.items.join('\n')),
        })
      )
    );
    const list = h('ul', { class: 'lines' });
    for (const item of order.items) list.append(h('li', { text: item }));
    box.append(list);
    wrap.append(box);
  } else if (order.payment.payUrl && order.status === 'pending') {
    wrap.append(
      h('a', {
        class: 'btn',
        href: order.payment.payUrl,
        text: `去支付 ${money(order.amount)}`,
        style: 'text-decoration:none',
      })
    );
  } else if (order.status === 'pending_manual') {
    wrap.append(h('div', { class: 'alert', text: '已收到付款，正在人工发货，请留意联系邮箱。' }));
  }

  return wrap;
}

function renderOrderPanel(order) {
  const panel = h('div', { class: 'panel' });
  panel.append(
    h('h2', { text: order.productTitle }),
    orderStatusBlock(order),
    h('hr', { style: 'border:0;border-top:1px solid var(--border);margin:18px 0' }),
    h(
      'dl',
      { class: 'kv' },
      h('dt', { text: '订单号' }), h('dd', { class: 'mono', text: order.id }),
      h('dt', { text: '商品' }), h('dd', { text: `${order.productTitle} × ${order.quantity}` }),
      h('dt', { text: '金额' }), h('dd', { text: money(order.amount) }),
      h('dt', { text: '发货方式' }), h('dd', { text: order.deliveryLabel }),
      h('dt', { text: '支付方式' }), h('dd', { text: order.payment.label || order.payment.driver || '—' }),
      h('dt', { text: '联系邮箱' }), h('dd', { text: order.contact.email || '—' }),
      h('dt', { text: '备注' }), h('dd', { text: order.contact.note || '—' })
    )
  );

  if (order.events?.length) {
    const timeline = h('ul', { class: 'timeline' });
    for (const event of [...order.events].reverse()) {
      timeline.append(
        h('li', null, h('span', { class: 'when', text: shortTime(event.at) }), h('span', { text: event.message }))
      );
    }
    panel.append(h('hr', { style: 'border:0;border-top:1px solid var(--border);margin:18px 0' }), h('h3', { text: '订单轨迹' }), timeline);
  }

  return panel;
}

async function pageOrder() {
  const mount = document.getElementById('mount');
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || '';
  const token = params.get('token') || '';

  clear(mount);

  if (params.get('error')) {
    mount.append(h('div', { class: 'alert danger', text: `订单查询失败：${params.get('error')}` }));
  }

  if (id) {
    try {
      const data = await api.get(`/api/orders/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
      rememberOrder(data.order, token);
      mount.append(renderOrderPanel(data.order));
      mount.append(h('p', { style: 'margin-top:16px' }, h('a', { href: '/', text: '返回全部商品' })));
      return;
    } catch (err) {
      mount.append(h('div', { class: 'alert danger', text: err.message }));
    }
  }

  const idInput = h('input', { class: 'input mono', type: 'text', placeholder: '例如 DM20261011ABCDEF' });
  const tokenInput = h('input', { class: 'input mono', type: 'text', placeholder: '下单时保存的查询凭证' });

  const form = h(
    'form',
    {
      class: 'panel',
      onsubmit: (event) => {
        event.preventDefault();
        const target = `/order.html?id=${encodeURIComponent(idInput.value.trim())}&token=${encodeURIComponent(tokenInput.value.trim())}`;
        location.href = target;
      },
    },
    h('h2', { text: '查询订单' }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '订单号' }), idInput),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '查询凭证' }), tokenInput),
    h('button', { class: 'btn', type: 'submit', text: '查询' })
  );

  mount.append(form);

  const local = loadLocalOrders();
  if (local.length) {
    const list = h('div', { class: 'panel' });
    list.append(h('h2', { text: '本机浏览过的订单' }));
    const table = h(
      'table',
      { class: 'data' },
      h('thead', null, h('tr', null, h('th', { text: '订单号' }), h('th', { text: '商品' }), h('th', { text: '时间' }))),
      h('tbody', null,
        ...local.map((item) =>
          h('tr', null,
            h('td', null, h('a', {
              class: 'mono',
              href: `/order.html?id=${encodeURIComponent(item.id)}&token=${encodeURIComponent(item.token)}`,
              text: item.id,
            })),
            h('td', { text: item.title || '—' }),
            h('td', { text: shortTime(item.at) })
          )
        )
      )
    );
    list.append(table);
    mount.append(list);
  }
}

/* ------------------------------------------------------------------ 页面：后台 */

function adminLogin(mount) {
  const password = h('input', { class: 'input', type: 'password', placeholder: '管理密码', autocomplete: 'current-password' });
  const form = h(
    'form',
    {
      class: 'panel',
      style: 'max-width:380px',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const data = await api.post('/api/admin/login', { password: password.value });
          state.adminToken = data.token;
          sessionStorage.setItem(TOKEN_KEY, data.token);
          if (data.insecureDefaultPassword) toast('当前仍在使用默认密码，请尽快修改');
          renderAdmin(mount);
        } catch (err) {
          toast(err.message);
        }
      },
    },
    h('h2', { text: '管理后台' }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '密码' }), password),
    h('button', { class: 'btn', type: 'submit', text: '登录', style: 'width:100%' }),
    h('p', { class: 'note', style: 'margin-top:10px', text: '密码由环境变量 ADMIN_PASSWORD 指定。' })
  );
  clear(mount).append(form);
}

function adminDeliverDialog(order) {
  const items = h('textarea', { class: 'input', placeholder: '每行一条交付内容' });
  const note = h('input', { class: 'input', type: 'text', placeholder: '给顾客看的说明（可选）' });
  const dialog = h('dialog', { class: 'modal' });

  const submit = h('button', {
    class: 'btn',
    type: 'button',
    text: '确认发货',
    onclick: async () => {
      try {
        await api.adminPost(`/api/admin/orders/${encodeURIComponent(order.id)}/deliver`, {
          items: items.value,
          note: note.value.trim(),
        });
        dialog.close();
        toast('已发货');
        renderAdmin(document.getElementById('mount'));
      } catch (err) {
        toast(err.message);
      }
    },
  });

  dialog.append(
    h('h2', { text: `人工发货 · ${order.id}` }),
    h('p', { class: 'note', style: 'margin:6px 0 16px', text: `${order.productTitle} × ${order.quantity}` }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '交付内容' }), items),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '订单说明' }), note),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', type: 'button', text: '取消', onclick: () => dialog.close() }),
      submit
    )
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

function adminImportDialog(product) {
  const keys = h('textarea', { class: 'input', placeholder: '每行一个卡密，重复的会自动跳过' });
  const dialog = h('dialog', { class: 'modal' });

  dialog.append(
    h('h2', { text: `导入卡密 · ${product.title}` }),
    h('p', {
      class: 'note',
      style: 'margin:6px 0 16px',
      text: `交付方式：${product.delivery} · 当前剩余 ${product.stock >= 0 ? product.stock : '未知'}`,
    }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: '卡密内容' }), keys),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn ghost', type: 'button', text: '取消', onclick: () => dialog.close() }),
      h('button', {
        class: 'btn',
        type: 'button',
        text: '导入',
        onclick: async () => {
          try {
            const data = await api.adminPost(`/api/admin/products/${encodeURIComponent(product.id)}/import`, {
              keys: keys.value,
            });
            dialog.close();
            toast(`已导入 ${data.result.imported} 条，跳过 ${data.result.skipped} 条`);
            renderAdmin(document.getElementById('mount'));
          } catch (err) {
            toast(err.message);
          }
        },
      })
    )
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

function adminStats(stats) {
  const items = [
    ['订单总数', stats.totalOrders],
    ['已付款', stats.paidOrders],
    ['已发货', stats.deliveredOrders],
    ['待人工发货', stats.pendingManual],
    ['待支付', stats.pendingPayment],
    ['累计收入', money(stats.revenue)],
  ];
  return h(
    'div',
    { class: 'admin-grid' },
    ...items.map(([key, value]) => h('div', { class: 'stat' }, h('div', { class: 'k', text: key }), h('div', { class: 'v', text: String(value) })))
  );
}

function adminProductsTable(catalog) {
  const body = h('tbody');
  for (const product of catalog) {
    const priceInput = h('input', { class: 'input', type: 'number', step: '0.01', min: '0', value: String(product.price), style: 'width:96px' });
    const activeBox = h('input', { type: 'checkbox', checked: product.active });
    const save = h('button', {
      class: 'btn ghost small',
      type: 'button',
      text: '保存',
      onclick: async () => {
        try {
          await api.adminPatch(`/api/admin/products/${encodeURIComponent(product.id)}`, {
            price: Number(priceInput.value),
            active: activeBox.checked,
          });
          toast('已保存');
          renderAdmin(document.getElementById('mount'));
        } catch (err) {
          toast(err.message);
        }
      },
    });
    const importBtn = h('button', {
      class: 'btn ghost small',
      type: 'button',
      text: '导入卡密',
      onclick: () => adminImportDialog(product),
    });

    body.append(
      h('tr', null,
        h('td', null, h('div', { text: product.title }), h('div', { class: 'note mono', text: product.id })),
        h('td', null, h('span', { class: 'badge', text: product.deliveryLabel }), h('div', { class: 'note', text: product.delivery })),
        h('td', { class: 'mono', text: product.stock >= 0 ? String(product.stock) : '—' }),
        h('td', null, priceInput),
        h('td', null, activeBox),
        h('td', { class: 'row-flex' }, save, importBtn)
      )
    );
  }
  return h(
    'table',
    { class: 'data' },
    h('thead', null,
      h('tr', null,
        h('th', { text: '商品' }),
        h('th', { text: '交付' }),
        h('th', { text: '库存' }),
        h('th', { text: '价格' }),
        h('th', { text: '上架' }),
        h('th', { text: '操作' })
      )
    ),
    body
  );
}

function adminOrdersTable(orders) {
  const body = h('tbody');
  const filters = [
    ['', '全部'],
    ['pending', '待支付'],
    ['pending_manual', '待人工发货'],
    ['delivered', '已发货'],
    ['paid', '待处理'],
    ['expired', '已超时'],
    ['failed', '创建失败'],
  ];
  const tabs = h('div', { class: 'tabs' });
  for (const [value, label] of filters) {
    tabs.append(
      h('button', {
        type: 'button',
        'aria-pressed': String(state.adminOrderFilter === value),
        text: label,
        onclick: () => {
          state.adminOrderFilter = value;
          renderAdmin(document.getElementById('mount'));
        },
      })
    );
  }

  for (const order of orders) {
    const actions = h('div', { class: 'row-flex' });
    if (order.status === 'pending' || order.status === 'failed') {
      actions.append(
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: '确认已收款',
          onclick: async () => {
            try {
              await api.adminPost(`/api/admin/orders/${encodeURIComponent(order.id)}/paid`);
              toast('已确认收款并触发发货');
              renderAdmin(document.getElementById('mount'));
            } catch (err) {
              toast(err.message);
            }
          },
        })
      );
    }
    if (order.status === 'paid' || order.status === 'pending_manual') {
      actions.append(
        h('button', {
          class: 'btn small',
          type: 'button',
          text: '人工发货',
          onclick: () => adminDeliverDialog(order),
        }),
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: '重试自动发货',
          onclick: async () => {
            try {
              await api.adminPost(`/api/admin/orders/${encodeURIComponent(order.id)}/fulfil`);
              toast('已重试');
              renderAdmin(document.getElementById('mount'));
            } catch (err) {
              toast(err.message);
            }
          },
        })
      );
    }
    if (order.status === 'delivered') {
      actions.append(
        h('button', {
          class: 'btn ghost small',
          type: 'button',
          text: '复制交付内容',
          onclick: () => copyText((order.items || []).join('\n')),
        })
      );
    }

    body.append(
      h('tr', null,
        h('td', null,
          h('div', { class: 'mono', text: order.id }),
          h('div', { class: 'note', text: shortTime(order.createdAt) })
        ),
        h('td', null,
          h('div', { text: order.productTitle }),
          h('div', { class: 'note', text: `× ${order.quantity} · ${money(order.amount)}` })
        ),
        h('td', null, statusBadge(order.status, order.statusLabel)),
        h('td', null,
          h('div', { class: 'note', text: order.contact?.email || '—' }),
          order.message ? h('div', { class: 'note', text: order.message }) : null
        ),
        h('td', null, actions)
      )
    );
  }

  if (orders.length === 0) {
    body.append(h('tr', null, h('td', { colspan: '5', class: 'empty', text: '没有符合条件的订单' })));
  }

  return h('div', null, tabs, h('table', { class: 'data' },
    h('thead', null,
      h('tr', null,
        h('th', { text: '订单' }),
        h('th', { text: '商品' }),
        h('th', { text: '状态' }),
        h('th', { text: '顾客' }),
        h('th', { text: '操作' })
      )
    ),
    body
  ));
}

async function renderAdmin(mount) {
  if (!state.adminToken) {
    const stored = sessionStorage.getItem(TOKEN_KEY);
    if (stored) state.adminToken = stored;
  }
  if (!state.adminToken) {
    adminLogin(mount);
    return;
  }

  clear(mount).append(h('div', { class: 'loading', text: '加载中…' }));

  let overview;
  let orders;
  let catalog;
  try {
    [overview, orders, catalog] = await Promise.all([
      api.adminGet('/api/admin/overview'),
      api.adminGet(`/api/admin/orders${state.adminOrderFilter ? `?status=${encodeURIComponent(state.adminOrderFilter)}` : ''}`),
      api.adminGet('/api/admin/products'),
    ]);
  } catch (err) {
    if (err.status === 401) {
      state.adminToken = '';
      sessionStorage.removeItem(TOKEN_KEY);
      adminLogin(mount);
      toast('会话已过期，请重新登录');
      return;
    }
    clear(mount).append(h('div', { class: 'alert danger', text: err.message }));
    return;
  }

  const header = h('div', { class: 'section-head' },
    h('h1', { text: '管理后台' }),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn ghost small',
      type: 'button',
      text: '退出登录',
      onclick: async () => {
        try {
          await api.adminPost('/api/admin/logout');
        } catch {
          /* 忽略 */
        }
        state.adminToken = '';
        sessionStorage.removeItem(TOKEN_KEY);
        renderAdmin(mount);
      },
    })
  );

  const panel = h('div', { class: 'stack' });
  panel.append(header);

  for (const warning of overview.warnings || []) {
    panel.append(h('div', { class: 'alert danger', text: warning }));
  }
  for (const item of overview.lowStock || []) {
    panel.append(h('div', { class: 'alert', text: `库存偏低：${item.title} 仅剩 ${item.stock} 件` }));
  }

  panel.append(adminStats(overview.stats));
  panel.append(
    h('div', { class: 'panel' },
      h('div', { class: 'row-flex' },
        h('h2', { text: '商品' }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'note', text: `支付：${overview.site.paymentLabel} · 交付：${overview.site.deliveryAdapters.join(' / ')}` })
      ),
      adminProductsTable(catalog.products)
    )
  );
  panel.append(h('div', { class: 'panel' }, h('h2', { text: '订单' }), adminOrdersTable(orders.orders)));

  clear(mount).append(panel);
}

async function pageAdmin() {
  const mount = document.getElementById('mount');
  await renderAdmin(mount);
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored) document.documentElement.dataset.theme = stored;

  const page = document.body.dataset.page || 'catalog';

  try {
    const data = await api.get('/api/site');
    state.site = data.site;
    state.currency = data.site.currency || '¥';
    state.maxQuantity = data.site.order?.maxQuantity || 20;
    if (!stored && data.site.theme?.defaultMode) applyTheme(data.site.theme.defaultMode);
  } catch (err) {
    const mount = document.getElementById('mount');
    if (mount) clear(mount).append(h('div', { class: 'alert danger', text: `无法读取站点配置：${err.message}` }));
    return;
  }

  renderShell();

  try {
    if (page === 'catalog') await pageCatalog();
    else if (page === 'product') await pageProduct();
    else if (page === 'order') await pageOrder();
    else if (page === 'admin') await pageAdmin();
  } catch (err) {
    const mount = document.getElementById('mount');
    if (mount) clear(mount).append(h('div', { class: 'alert danger', text: err.message }));
  }
}

document.addEventListener('DOMContentLoaded', boot);
