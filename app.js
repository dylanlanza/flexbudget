/* FlexBudget — a flexible budget for variable income.
 * All data lives in this browser's localStorage (no account, no server).
 */
(() => {
  'use strict';

  // ---------- helpers ----------
  const KEY = 'flexbudget:v1';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (arr, f = (x) => x.amount) => r2(arr.reduce((t, x) => t + (Number(f(x)) || 0), 0));
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const thisMonth = () => monthKey(new Date());
  const shiftMonth = (m, delta) => { const [y, mo] = m.split('-').map(Number); return monthKey(new Date(y, mo - 1 + delta, 1)); };
  const monthName = (m, opts = { month: 'long', year: 'numeric' }) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString(undefined, opts); };
  const daysIn = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const prettyDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
  const defaultDateFor = (m) => (m === thisMonth() ? todayISO() : `${m}-01`);

  const PALETTE = ['#8a9a73', '#c4a265', '#d2a797', '#a8927a', '#6f7d55', '#c08467', '#93a3a0', '#a68b98', '#d8c193', '#7b6a5a'];

  // ---------- state ----------
  function defaults() {
    return {
      version: 1,
      settings: { name: '', currency: 'USD', incomeGoal: 0, sources: ['Services', 'Tips', 'Product sales', 'Other'], onboarded: false, rollover: true },
      bills: [],        // { id, name, amount, dueDay, from, until? }
      categories: [],   // { id, name, mode: 'percent'|'fixed'|'leftover', value, color }
      income: [],       // { id, date, amount, source, note }
      spending: [],     // { id, date, amount, categoryId, note }
      paid: {},         // { 'YYYY-MM': [billId, ...] }
      updatedAt: null,
    };
  }
  function migrate(d) {
    const base = defaults();
    const out = { ...base, ...d, settings: { ...base.settings, ...(d.settings || {}) } };
    for (const k of ['bills', 'categories', 'income', 'spending']) if (!Array.isArray(out[k])) out[k] = [];
    if (!out.paid || typeof out.paid !== 'object') out.paid = {};
    return out;
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? migrate(JSON.parse(raw)) : defaults();
    } catch (e) {
      console.error('FlexBudget: could not read saved data', e);
      return defaults();
    }
  }
  let state = load();
  function save() {
    resetMemo();
    state.updatedAt = new Date().toISOString();
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('Hmm, this browser blocked saving. Try turning off Private Browsing.'); }
  }
  // Ask the browser not to evict our storage.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // Keep multiple open tabs in sync.
  window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load(); render(); } });

  const ui = {
    tab: (location.hash.slice(1) || 'overview'),
    month: thisMonth(),
    spendFilter: 'all',
  };
  if (!['overview', 'income', 'bills', 'categories', 'settings'].includes(ui.tab)) ui.tab = 'overview';

  // ---------- money ----------
  const fmtCache = {};
  function fmt(cur) {
    if (!fmtCache[cur]) {
      try { fmtCache[cur] = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }); }
      catch { fmtCache[cur] = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }); }
    }
    return fmtCache[cur];
  }
  const money = (n) => fmt(state.settings.currency || 'USD').format(r2(n));
  const curSymbol = () => (fmt(state.settings.currency || 'USD').formatToParts(0).find((p) => p.type === 'currency') || {}).value || '$';

  // ---------- calculations ----------
  const inMonth = (m) => (x) => x.date && x.date.startsWith(m);
  const activeBills = (m) => state.bills.filter((b) => (!b.from || b.from <= m) && (!b.until || m <= b.until)).sort((a, b) => (a.dueDay || 99) - (b.dueDay || 99));
  const catById = (id) => state.categories.find((c) => c.id === id);

  // Carry-over: each month starts with what the previous month left behind.
  //  - poolCarry: unassigned money (negative if last month's bills/plans outran income)
  //  - catCarry:  each category's unused balance (negative if it was overspent)
  // Results are memoized per month and cleared whenever data changes.
  let memo = {};
  let memoFirst;
  const resetMemo = () => { memo = {}; memoFirst = undefined; };
  const rolloverOn = () => state.settings.rollover !== false;
  function firstMonth() {
    if (memoFirst === undefined) {
      const ms = [...state.income, ...state.spending].map((x) => (x.date || '').slice(0, 7))
        .concat(state.bills.map((b) => b.from)).filter(Boolean).sort();
      memoFirst = ms[0] || null;
    }
    return memoFirst;
  }

  function summary(m, extraIncome = 0) {
    if (!extraIncome && memo[m]) return memo[m];
    const income = state.income.filter(inMonth(m));
    const spending = state.spending.filter(inMonth(m));
    const earned = r2(sum(income) + extraIncome);
    const bills = activeBills(m);
    const billsTotal = sum(bills);
    const paidIds = new Set(state.paid[m] || []);
    const billsPaid = sum(bills.filter((b) => paidIds.has(b.id)));

    const prev = shiftMonth(m, -1);
    const fm = firstMonth();
    let poolCarry = 0, catCarry = {};
    if (rolloverOn() && fm && prev >= fm) {
      const p = summary(prev);
      poolCarry = p.poolOut;
      catCarry = p.catOut;
    }
    const flexible = r2(earned + poolCarry - billsTotal);
    const base = Math.max(0, flexible);

    const alloc = {};
    let planned = 0;
    for (const c of state.categories) {
      if (c.mode === 'percent') alloc[c.id] = r2((base * (Number(c.value) || 0)) / 100);
      else if (c.mode === 'fixed') alloc[c.id] = r2(c.value);
      else continue;
      planned += alloc[c.id];
    }
    const leftoverCats = state.categories.filter((c) => c.mode === 'leftover');
    const remaining = r2(base - planned);
    if (leftoverCats.length) {
      const each = r2(Math.max(0, remaining) / leftoverCats.length);
      leftoverCats.forEach((c) => { alloc[c.id] = each; planned += each; });
    }
    planned = r2(planned);
    const unassigned = r2(base - planned);

    const spent = {};
    let uncategorized = 0;
    for (const s of spending) {
      if (catById(s.categoryId)) spent[s.categoryId] = r2((spent[s.categoryId] || 0) + s.amount);
      else uncategorized = r2(uncategorized + s.amount);
    }
    const totalSpent = sum(spending);

    // Balance in each category = this month's share + what rolled in − what was spent.
    const carry = {}, balance = {}, catOut = {};
    let poolOut = r2(flexible - planned - uncategorized);
    for (const c of state.categories) {
      carry[c.id] = r2(catCarry[c.id] || 0);
      balance[c.id] = r2((alloc[c.id] || 0) + carry[c.id] - (spent[c.id] || 0));
      if (c.rollover === 'pool') poolOut = r2(poolOut + balance[c.id]);
      else catOut[c.id] = balance[c.id];
    }
    const carriedToCats = r2(Object.values(carry).reduce((t, v) => t + v, 0));

    const out = { m, income, spending, earned, poolCarry: r2(poolCarry), carry, carriedToCats, bills, billsTotal, billsPaid, paidIds, flexible, base, alloc, planned, unassigned, spent, uncategorized, totalSpent, balance, poolOut, catOut };
    if (!extraIncome) memo[m] = out;
    return out;
  }

  // How a new deposit would be divided (first covers bills, then the categories).
  function splitPreview(m, amount) {
    const before = summary(m), after = summary(m, amount);
    const lines = [];
    const toBills = r2(Math.min(amount, Math.max(0, -before.flexible)));
    if (toBills > 0) lines.push({ label: 'Covers bills', amount: toBills, color: 'var(--gold)' });
    for (const c of state.categories) {
      const d = r2((after.alloc[c.id] || 0) - (before.alloc[c.id] || 0));
      if (d > 0.004) lines.push({ label: c.name, amount: d, color: c.color });
    }
    let un = r2(after.unassigned - before.unassigned);
    if (un > 0.004 && before.unassigned < 0) {
      const catchUp = r2(Math.min(un, -before.unassigned));
      lines.push({ label: 'Funds your set amounts', amount: catchUp, color: 'var(--sage)' });
      un = r2(un - catchUp);
    }
    if (un > 0.004) lines.push({ label: 'Unassigned', amount: un, color: 'var(--line)' });
    return lines;
  }

  // ---------- UI primitives ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  const sheet = $('#sheet');
  let sheetSubmit = null;
  function openSheet(title, html, onSubmit, onMount) {
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    sheetSubmit = onSubmit || null;
    if (!sheet.open) sheet.showModal();
    if (onMount) onMount($('#sheetBody'));
    const first = $('#sheetBody [autofocus]');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeSheet() { if (sheet.open) sheet.close(); sheetSubmit = null; }
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) closeSheet();
  });
  sheet.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sheetSubmit) sheetSubmit(new FormData(e.target), e.target, e.submitter);
  });

  function confirmSheet(title, message, yesLabel, onYes) {
    openSheet(title, `
      <form class="form">
        <p style="margin:0 0 6px;color:var(--ink-2)">${message}</p>
        <div class="btn-row end">
          <button type="button" class="btn ghost" data-close>Never mind</button>
          <button type="submit" class="btn danger">${esc(yesLabel)}</button>
        </div>
      </form>`, () => { onYes(); closeSheet(); });
  }

  const moneyField = (name, value = '', { big = false, autofocus = false, label = 'Amount' } = {}) => `
    <label class="field">${esc(label)}
      <div class="money-input ${big ? 'big' : ''}">
        <span class="cur">${esc(curSymbol())}</span>
        <input class="input num" name="${name}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${value === '' ? '' : r2(value)}" required ${autofocus ? 'autofocus' : ''} />
      </div>
    </label>`;

  const parseAmount = (v) => r2(String(v).replace(/[^0-9.]/g, ''));

  const empty = (flourish, text, btn = '') => `<div class="empty"><div class="flourish">${flourish}</div><p>${text}</p>${btn}</div>`;

  // ---------- garland (fairy lights + greenery) ----------
  function drawGarland() {
    const svg = $('#garland');
    const w = Math.max(320, window.innerWidth);
    const h = 78;
    const span = w < 600 ? 180 : 260;
    const hooks = Math.ceil(w / span) + 1;
    let wire = '', leaves = '', bulbs = '';
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let i = 0; i < hooks; i++) {
      const x0 = i * span - 20, x1 = x0 + span, cx = (x0 + x1) / 2, y0 = 8, cy = 44 + rnd() * 10;
      wire += `M${x0},${y0} Q${cx},${cy} ${x1},${y0} `;
      const pt = (t) => ({ x: (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1, y: (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y0 });
      for (let t = 0.04; t < 1; t += 0.065) {
        const p = pt(t);
        const ang = (rnd() * 140 - 70).toFixed(0);
        leaves += `<ellipse class="leaf ${rnd() > .5 ? 'dark' : ''}" cx="${p.x.toFixed(1)}" cy="${(p.y + 3).toFixed(1)}" rx="7" ry="3" transform="rotate(${ang} ${p.x.toFixed(1)} ${(p.y + 3).toFixed(1)})"/>`;
      }
      for (let t = 0.08; t < 1; t += 0.14) {
        const p = pt(t + rnd() * 0.03);
        const by = p.y + 6 + rnd() * 6;
        const delay = (rnd() * 3.6).toFixed(2);
        bulbs += `<circle class="bulb" filter="url(#glow)" cx="${p.x.toFixed(1)}" cy="${by.toFixed(1)}" r="5.5" style="animation-delay:${delay}s"/><circle class="bulb-core" cx="${p.x.toFixed(1)}" cy="${by.toFixed(1)}" r="1.8"/>`;
      }
    }
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<defs><filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <path class="wire" d="${wire}"/>${leaves}${bulbs}`;
  }
  let garlandW = 0;
  window.addEventListener('resize', () => { if (Math.abs(window.innerWidth - garlandW) > 40) { garlandW = window.innerWidth; drawGarland(); } });

  // ---------- header ----------
  function renderHeader() {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = state.settings.name.trim();
    $('#greeting').textContent = name ? `${part}, ${name} ✨` : `${part} ✨`;
    $('#monthLabel').textContent = monthName(ui.month);
    $('#todayBtn').hidden = ui.month === thisMonth();
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  }

  // ---------- shared pieces ----------
  function txRow(t, kind) {
    if (kind === 'in') {
      return `<li class="row clickable" data-action="edit-income" data-id="${t.id}">
        <div class="ico in">↑</div>
        <div class="main"><div class="title">${esc(t.source || 'Income')}</div><div class="meta">${prettyDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
        <div class="amt in">+${money(t.amount)}</div></li>`;
    }
    const c = catById(t.categoryId);
    return `<li class="row clickable" data-action="edit-spend" data-id="${t.id}">
      <div class="ico out"><span class="dot" style="background:${c ? c.color : 'var(--muted)'}"></span></div>
      <div class="main"><div class="title">${esc(t.note || (c ? c.name : 'Uncategorized'))}</div><div class="meta">${c ? esc(c.name) : 'Uncategorized'} · ${prettyDate(t.date)}</div></div>
      <div class="amt">−${money(t.amount)}</div></li>`;
  }

  function envelope(c, s) {
    const cr = s.carry[c.id] || 0, a = r2((s.alloc[c.id] || 0) + cr), sp = s.spent[c.id] || 0, left = s.balance[c.id] || 0;
    const pct = a > 0 ? Math.min(100, (sp / a) * 100) : (sp > 0 || a < 0 ? 100 : 0);
    const over = left < 0;
    const rule = c.mode === 'percent' ? `${r2(c.value)}% of flexible` : c.mode === 'fixed' ? 'Set amount' : 'Gets leftovers';
    return `<button class="env" data-action="filter-cat" data-id="${c.id}">
      <div class="env-top"><span class="dot" style="background:${c.color}"></span><span class="name">${esc(c.name)}</span></div>
      <div class="env-left ${over ? 'clay-text' : ''}">${over ? money(-left) + ' over' : money(left)}</div>
      <div class="env-meta">${money(sp)} spent of ${money(a)} · ${rule}${carryNote(cr)}</div>
      <div class="meter ${over ? 'over' : ''}"><i style="width:${pct}%;${over ? '' : `background:${c.color}`}"></i></div>
    </button>`;
  }

  const prevName = (m) => monthName(shiftMonth(m, -1), { month: 'long' });
  function carryNote(cr) {
    if (Math.abs(cr) < 0.005) return '';
    return cr > 0 ? `<br><span class="sage-text">+${money(cr)} rolled over from ${esc(prevName(ui.month))}</span>`
      : `<br><span class="clay-text">−${money(-cr)} overspent in ${esc(prevName(ui.month))}</span>`;
  }

  function allocationBar(s) {
    if (!state.categories.length) return '';
    const total = Math.max(s.base, s.planned, 1);
    const parts = state.categories.map((c) => ({ c, v: s.alloc[c.id] || 0 })).filter((p) => p.v > 0);
    const bar = parts.map((p) => `<i style="width:${(p.v / total) * 100}%;background:${p.c.color}" title="${esc(p.c.name)}"></i>`).join('')
      + (s.unassigned > 0 ? `<i style="width:${(s.unassigned / total) * 100}%;background:repeating-linear-gradient(45deg,#e9dfcf 0 4px,#f2eadd 4px 8px)" title="Unassigned"></i>` : '');
    const legend = parts.map((p) => `<span><i class="dot" style="background:${p.c.color}"></i>${esc(p.c.name)} <b class="num">${money(p.v)}</b></span>`).join('')
      + (s.unassigned > 0 ? `<span><i class="dot" style="background:#e9dfcf"></i>Unassigned <b class="num">${money(s.unassigned)}</b></span>` : '');
    return `<div class="stackbar">${bar}</div><div class="legend">${legend}</div>`;
  }

  function planNotice(s) {
    if (s.unassigned < -0.004) {
      return `<div class="notice clay" style="margin-top:14px">You've planned <b>${money(-s.unassigned)}</b> more than you have so far this month. That's normal early on — it'll balance out as clients come in, or you can lower a set amount.</div>`;
    }
    const pctTotal = state.categories.filter((c) => c.mode === 'percent').reduce((t, c) => t + (Number(c.value) || 0), 0);
    if (pctTotal > 100) return `<div class="notice clay" style="margin-top:14px">Your percentages add up to ${r2(pctTotal)}% — over 100%.</div>`;
    if (s.unassigned > 0.004 && state.categories.length) {
      return `<div class="notice sage" style="margin-top:14px"><b>${money(s.unassigned)}</b> hasn't been given a job yet. Raise a percentage, or set a category to “gets leftovers”.</div>`;
    }
    return '';
  }

  // ---------- views ----------
  function viewOverview() {
    const s = summary(ui.month);
    const goal = Number(state.settings.incomeGoal) || 0;
    const covered = s.billsTotal > 0 ? Math.max(0, Math.min(100, ((s.earned + s.poolCarry) / s.billsTotal) * 100)) : 100;
    const paidCount = s.bills.filter((b) => s.paidIds.has(b.id)).length;
    const leftToSpend = r2(state.categories.reduce((t, c) => t + Math.max(0, s.balance[c.id] || 0), 0));

    const recent = [
      ...s.income.map((t) => ({ t, k: 'in' })),
      ...s.spending.map((t) => ({ t, k: 'out' })),
    ].sort((a, b) => (b.t.date + (b.t.createdAt || '')).localeCompare(a.t.date + (a.t.createdAt || ''))).slice(0, 7);

    return `
    <div class="grid grid-2">
      <div class="stack">
        <section class="card hero">
          <p class="eyebrow">Flexible money · ${esc(monthName(ui.month, { month: 'long' }))}</p>
          <h2 class="hero-num num ${s.flexible < 0 ? 'neg' : ''}">${money(s.flexible)}</h2>
          <p class="hero-sub">${money(s.earned)} earned${Math.abs(s.poolCarry) >= 0.005 ? ` ${s.poolCarry > 0 ? '+' : '−'} ${money(Math.abs(s.poolCarry))} ${s.poolCarry > 0 ? 'carried over' : 'short from last month'}` : ''} − ${money(s.billsTotal)} in bills</p>
          ${s.billsTotal > 0 ? `
            <div class="meter-label"><span>Bills covered</span><span class="num">${Math.round(covered)}%</span></div>
            <div class="meter gold"><i style="width:${covered}%"></i></div>
            ${s.flexible < 0 ? `<p class="muted" style="margin:8px 0 0;font-size:.85rem">${money(-s.flexible)} more covers this month's bills.</p>` : ''}` : ''}
          <div class="hero-actions">
            <button class="btn gold" data-action="add-income">+ Money in</button>
            <button class="btn ghost" data-action="add-spend">− Money out</button>
          </div>
        </section>

        <div class="stats">
          <div class="stat">
            <div class="label">Earned</div>
            <div class="value num">${money(s.earned)}</div>
            ${goal > 0 ? `<div class="meter gold"><i style="width:${Math.min(100, (s.earned / goal) * 100)}%"></i></div><div class="hint">${Math.round((s.earned / goal) * 100)}% of ${money(goal)} goal</div>` : `<div class="hint">${s.income.length} deposit${s.income.length === 1 ? '' : 's'}</div>`}
          </div>
          <div class="stat">
            <div class="label">Bills paid</div>
            <div class="value num">${paidCount}<span class="muted" style="font-size:1.1rem"> / ${s.bills.length}</span></div>
            <div class="hint">${money(s.billsPaid)} of ${money(s.billsTotal)}</div>
          </div>
          <div class="stat">
            <div class="label">Spent</div>
            <div class="value num">${money(s.totalSpent)}</div>
            <div class="hint">${money(leftToSpend)} left in categories</div>
          </div>
          <div class="stat">
            <div class="label">Unassigned</div>
            <div class="value num ${s.unassigned < 0 ? 'clay-text' : ''}">${money(s.unassigned)}</div>
            <div class="hint">${s.unassigned < 0 ? 'planned ahead of income' : 'ready to divvy up'}</div>
          </div>
        </div>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><h3>Where it's going</h3><button class="btn ghost small" data-tab-go="categories">Edit plan</button></div>
          ${state.categories.length ? `${allocationBar(s)}<hr class="divider" /><div class="envelopes">${state.categories.map((c) => envelope(c, s)).join('')}</div>${planNotice(s)}`
            : empty('❦', 'Create categories to divvy up what\'s left after bills — like Savings, Taxes, or Fun money.', '<button class="btn sage" data-tab-go="categories">Set up categories</button>')}
        </section>

        <section class="card">
          <div class="card-head"><h3>Recent</h3></div>
          ${recent.length ? `<ul class="list">${recent.map((r) => txRow(r.t, r.k)).join('')}</ul>`
            : empty('✧', 'Nothing logged for this month yet. Tap <b>+</b> to add money in or out.')}
        </section>
      </div>
    </div>`;
  }

  function viewIncome() {
    const s = summary(ui.month);
    const goal = Number(state.settings.incomeGoal) || 0;
    const bySource = {};
    s.income.forEach((i) => { bySource[i.source || 'Other'] = r2((bySource[i.source || 'Other'] || 0) + i.amount); });
    const srcRows = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
    const max = srcRows.length ? srcRows[0][1] : 1;
    const sorted = [...s.income].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const days = {};
    sorted.forEach((i) => { (days[i.date] = days[i.date] || []).push(i); });
    const avgPerDayWorked = Object.keys(days).length ? r2(s.earned / Object.keys(days).length) : 0;

    return `
    <div class="grid grid-2">
      <div class="stack">
        <section class="card">
          <h3>Log money in</h3>
          <p class="sub">Clients, tips, product sales — add each deposit as it comes.</p>
          ${incomeForm({}, 'inline')}
        </section>
        <section class="card">
          <div class="card-head"><h3>${esc(monthName(ui.month, { month: 'long' }))} so far</h3><span class="num" style="font-family:var(--serif);font-size:1.5rem;font-weight:600">${money(s.earned)}</span></div>
          ${Math.abs(s.poolCarry) >= 0.005 ? `<div class="notice ${s.poolCarry > 0 ? 'sage' : 'clay'}" style="margin-bottom:14px">${s.poolCarry > 0
            ? `<b>+${money(s.poolCarry)}</b> carried over from ${esc(prevName(ui.month))} — it's added to this month's money to divvy up.`
            : `${esc(prevName(ui.month))} ended <b>${money(-s.poolCarry)}</b> short, so that comes out of this month first.`}</div>` : ''}
          ${goal > 0 ? `<div class="meter-label"><span>Monthly goal</span><span class="num">${money(s.earned)} / ${money(goal)}</span></div><div class="meter gold"><i style="width:${Math.min(100, (s.earned / goal) * 100)}%"></i></div>` : ''}
          <form class="form" data-form="goal" style="margin-top:14px">
            <div class="form-row" style="grid-template-columns:1fr auto;align-items:end">
              ${moneyField('goal', goal || '', { label: 'Monthly income goal (optional)' }).replace('required', '')}
              <button class="btn ghost" type="submit">Save</button>
            </div>
          </form>
          ${srcRows.length ? `<hr class="divider"/><p class="eyebrow">By source</p><div class="bars">${srcRows.map(([k, v]) => `
            <div class="bar-row"><span>${esc(k)}</span><span class="num">${money(v)}</span><div class="meter"><i style="width:${(v / max) * 100}%"></i></div></div>`).join('')}</div>
            <p class="muted" style="font-size:.85rem;margin:14px 0 0">Average ${money(avgPerDayWorked)} per day you logged income.</p>` : ''}
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Deposits</h3><span class="muted">${s.income.length}</span></div>
        ${sorted.length ? `<ul class="list">${Object.entries(days).map(([d, items]) => `<li class="day-head">${prettyDate(d)} · ${money(sum(items))}</li>${items.map((i) => txRow(i, 'in')).join('')}`).join('')}</ul>`
          : empty('✧', 'No income logged for this month yet.')}
      </section>
    </div>`;
  }

  function incomeForm(t = {}, where = 'sheet') {
    const sources = state.settings.sources.length ? state.settings.sources : ['Income'];
    const cur = t.source && !sources.includes(t.source) ? [...sources, t.source] : sources;
    return `<form class="form" data-form="income" data-where="${where}">
      ${moneyField('amount', t.amount ?? '', { big: where === 'sheet', autofocus: where === 'sheet' })}
      <div class="form-row stack-sm">
        <label class="field">Date<input class="input" type="date" name="date" value="${t.date || defaultDateFor(ui.month)}" required /></label>
        <label class="field">Source<select class="input" name="source">${cur.map((x) => `<option ${x === (t.source || sources[0]) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      </div>
      <label class="field">Note (optional)<input class="input" name="note" maxlength="80" placeholder="e.g. balayage + cut" value="${esc(t.note || '')}" /></label>
      ${t.id ? '' : '<div class="split-preview" data-split hidden></div>'}
      <div class="btn-row ${t.id ? 'split' : 'end'}">
        ${t.id ? `<button type="button" class="btn danger" data-action="delete-income" data-id="${t.id}">Delete</button>` : ''}
        <button type="submit" class="btn gold">${t.id ? 'Save changes' : 'Add income'}</button>
      </div>
    </form>`;
  }

  function spendForm(t = {}) {
    if (!state.categories.length) {
      return empty('❦', 'Spending goes into a category. Make your first one, then come back here.', '<button class="btn sage" data-tab-go="categories">Create a category</button>');
    }
    const s = summary(ui.month);
    const selected = t.categoryId || (ui.spendFilter !== 'all' && catById(ui.spendFilter) ? ui.spendFilter : state.categories[0].id);
    return `<form class="form" data-form="spend">
      ${moneyField('amount', t.amount ?? '', { big: true, autofocus: true })}
      <label class="field">Category</label>
      <div class="chips" role="radiogroup">
        ${state.categories.map((c) => `<label class="chip ${c.id === selected ? 'active' : ''}"><input type="radio" name="categoryId" value="${c.id}" ${c.id === selected ? 'checked' : ''} hidden /><i class="dot" style="background:${c.color}"></i>${esc(c.name)} <span class="muted num">${money(s.balance[c.id] || 0)}</span></label>`).join('')}
        ${t.id && !catById(t.categoryId) ? '<label class="chip active"><input type="radio" name="categoryId" value="" checked hidden />Uncategorized</label>' : ''}
      </div>
      <div class="form-row stack-sm">
        <label class="field">Date<input class="input" type="date" name="date" value="${t.date || defaultDateFor(ui.month)}" required /></label>
        <label class="field">What for? (optional)<input class="input" name="note" maxlength="80" placeholder="e.g. Trader Joe's" value="${esc(t.note || '')}" /></label>
      </div>
      <div class="btn-row ${t.id ? 'split' : 'end'}">
        ${t.id ? `<button type="button" class="btn danger" data-action="delete-spend" data-id="${t.id}">Delete</button>` : ''}
        <button type="submit" class="btn gold">${t.id ? 'Save changes' : 'Add spending'}</button>
      </div>
    </form>`;
  }

  function viewBills() {
    const s = summary(ui.month);
    const isNow = ui.month === thisMonth();
    const today = new Date().getDate();
    const rows = s.bills.map((b) => {
      const paid = s.paidIds.has(b.id);
      let tag = '';
      if (!paid && isNow && b.dueDay) {
        if (b.dueDay < today) tag = '<span class="tag late">Past due</span>';
        else if (b.dueDay - today <= 5) tag = '<span class="tag">Due soon</span>';
      }
      if (paid) tag = '<span class="tag sage">Paid</span>';
      const due = b.dueDay ? `Due the ${ordinal(Math.min(b.dueDay, daysIn(ui.month)))}` : 'No due date';
      return `<li class="row ${paid ? 'paid' : ''}">
        <button class="check ${paid ? 'on' : ''}" data-action="toggle-paid" data-id="${b.id}" aria-pressed="${paid}" aria-label="Mark ${esc(b.name)} ${paid ? 'unpaid' : 'paid'}"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
        <div class="main clickable" data-action="edit-bill" data-id="${b.id}" style="cursor:pointer"><div class="title">${esc(b.name)}${tag}</div><div class="meta">${due}</div></div>
        <div class="amt">${money(b.amount)}</div>
      </li>`;
    }).join('');
    const pct = s.billsTotal ? (s.billsPaid / s.billsTotal) * 100 : 0;

    return `
    <div class="grid grid-2">
      <section class="card">
        <div class="card-head"><h3>Fixed bills</h3><span class="num" style="font-family:var(--serif);font-size:1.5rem;font-weight:600">${money(s.billsTotal)}<span class="muted" style="font-size:.95rem;font-family:var(--sans);font-weight:400"> / mo</span></span></div>
        ${s.bills.length ? `
          <div class="meter-label"><span>Paid in ${esc(monthName(ui.month, { month: 'long' }))}</span><span class="num">${money(s.billsPaid)} of ${money(s.billsTotal)}</span></div>
          <div class="meter gold"><i style="width:${pct}%"></i></div>
          <ul class="list" style="margin-top:10px">${rows}</ul>
          <p class="muted" style="font-size:.82rem;margin:10px 0 0">Tap the circle to check a bill off. Tap the name to edit it.</p>`
          : empty('✧', 'Add the things you pay every month — rent, phone, car, booth rent, subscriptions.')}
      </section>
      <section class="card">
        <h3>Add a bill</h3>
        <p class="sub">Bills repeat every month automatically, starting ${esc(monthName(ui.month))}.</p>
        ${billForm({})}
      </section>
    </div>`;
  }

  function billForm(b = {}) {
    return `<form class="form" data-form="bill">
      <label class="field">Name<input class="input" name="name" maxlength="40" placeholder="e.g. Rent" value="${esc(b.name || '')}" required ${b.id ? 'autofocus' : ''} /></label>
      <div class="form-row">
        ${moneyField('amount', b.amount ?? '')}
        <label class="field">Due day<input class="input" type="number" inputmode="numeric" name="dueDay" min="1" max="31" placeholder="1–31" value="${b.dueDay || ''}" /></label>
      </div>
      <div class="btn-row ${b.id ? 'split' : 'end'}">
        ${b.id ? `<button type="button" class="btn danger" data-action="delete-bill" data-id="${b.id}">Remove</button>` : ''}
        <button type="submit" class="btn gold">${b.id ? 'Save changes' : 'Add bill'}</button>
      </div>
    </form>`;
  }

  function viewCategories() {
    const s = summary(ui.month);
    const pctTotal = state.categories.filter((c) => c.mode === 'percent').reduce((t, c) => t + (Number(c.value) || 0), 0);
    const filter = ui.spendFilter;
    const spending = s.spending.filter((t) => filter === 'all' || t.categoryId === filter || (filter === 'none' && !catById(t.categoryId)))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

    const catRows = state.categories.map((c, i) => {
      const rule = c.mode === 'percent' ? `${r2(c.value)}% of flexible money` : c.mode === 'fixed' ? `${money(c.value)} each month` : 'Gets whatever is left';
      return `<li class="row">
        <div style="display:flex;flex-direction:column;gap:2px">
          <button class="icon-btn" style="width:24px;height:20px;font-size:.8rem;${i === 0 ? 'visibility:hidden' : ''}" data-action="move-cat" data-dir="-1" data-id="${c.id}" aria-label="Move up">▲</button>
          <button class="icon-btn" style="width:24px;height:20px;font-size:.8rem;${i === state.categories.length - 1 ? 'visibility:hidden' : ''}" data-action="move-cat" data-dir="1" data-id="${c.id}" aria-label="Move down">▼</button>
        </div>
        <span class="dot" style="background:${c.color};width:14px;height:14px"></span>
        <div class="main clickable" data-action="edit-cat" data-id="${c.id}" style="cursor:pointer"><div class="title">${esc(c.name)}</div><div class="meta">${rule}</div></div>
        <div style="text-align:right"><div class="amt">${money(s.alloc[c.id] || 0)}</div><div class="meta muted" style="font-size:.75rem">${Math.abs(s.carry[c.id] || 0) >= 0.005 ? `${(s.carry[c.id] > 0 ? '+' : '−') + money(Math.abs(s.carry[c.id]))} rolled · ` : ''}${money(s.spent[c.id] || 0)} spent</div></div>
      </li>`;
    }).join('');

    return `
    <div class="grid grid-2">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h3>Your plan</h3><span class="muted" style="font-size:.85rem">${money(s.base)} to divvy</span></div>
          ${state.categories.length ? `${allocationBar(s)}<ul class="list" style="margin-top:12px">${catRows}</ul>
            <p class="muted" style="font-size:.82rem;margin:10px 0 0">Percentages total ${r2(pctTotal)}%. Tap a name to edit.</p>${planNotice(s)}`
            : `${empty('❦', 'Categories divide up what\'s left after bills. Use percentages so they grow with a busy month, set amounts for steady things, and one “leftovers” bucket to catch the rest.', '<button class="btn ghost" data-action="starter-cats">Add a starter set</button>')}`}
        </section>
        <section class="card">
          <h3>New category</h3>
          <p class="sub">Name it anything — and choose how it gets its money.</p>
          ${catForm({})}
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Spending</h3><button class="btn gold small" data-action="add-spend">− Add spending</button></div>
        ${state.categories.length || s.spending.length ? `<div class="chips" style="margin-bottom:10px">
          <button class="chip ${filter === 'all' ? 'active' : ''}" data-action="filter-cat" data-id="all">All · ${money(s.totalSpent)}</button>
          ${state.categories.map((c) => `<button class="chip ${filter === c.id ? 'active' : ''}" data-action="filter-cat" data-id="${c.id}"><i class="dot" style="background:${c.color}"></i>${esc(c.name)}</button>`).join('')}
          ${s.uncategorized > 0 ? `<button class="chip ${filter === 'none' ? 'active' : ''}" data-action="filter-cat" data-id="none">Uncategorized</button>` : ''}
        </div>` : ''}
        ${spending.length ? `<ul class="list">${spending.map((t) => txRow(t, 'out')).join('')}</ul>` : empty('✧', 'No spending logged here this month.')}
      </section>
    </div>`;
  }

  function catForm(c = {}) {
    const mode = c.mode || 'percent';
    const color = c.color || PALETTE[state.categories.length % PALETTE.length];
    return `<form class="form" data-form="cat">
      <label class="field">Name<input class="input" name="name" maxlength="30" placeholder="e.g. Savings, Taxes, Fun money" value="${esc(c.name || '')}" required /></label>
      <label class="field">How it gets money</label>
      <div class="seg" data-seg="mode">
        <button type="button" data-mode="percent" class="${mode === 'percent' ? 'active' : ''}">% of flexible</button>
        <button type="button" data-mode="fixed" class="${mode === 'fixed' ? 'active' : ''}">Set amount</button>
        <button type="button" data-mode="leftover" class="${mode === 'leftover' ? 'active' : ''}">Leftovers</button>
      </div>
      <input type="hidden" name="mode" value="${mode}" />
      <div data-mode-field="percent" ${mode === 'percent' ? '' : 'hidden'}>
        <label class="field">Percent<div class="suffix-input"><input class="input num" type="number" inputmode="decimal" name="percent" min="0" max="100" step="0.5" placeholder="10" value="${mode === 'percent' ? r2(c.value) || '' : ''}" /><span class="suf">%</span></div></label>
      </div>
      <div data-mode-field="fixed" ${mode === 'fixed' ? '' : 'hidden'}>
        ${moneyField('fixed', mode === 'fixed' ? c.value : '', { label: 'Amount each month' }).replace('required', '')}
      </div>
      <p class="muted" data-mode-field="leftover" style="margin:0;font-size:.85rem" ${mode === 'leftover' ? '' : 'hidden'}>Anything not claimed by your other categories lands here — great for savings.</p>
      <label class="field">At the end of the month, unused money…</label>
      <div class="seg" data-seg="roll">
        <button type="button" data-roll="keep" class="${c.rollover !== 'pool' ? 'active' : ''}">Stays here</button>
        <button type="button" data-roll="pool" class="${c.rollover === 'pool' ? 'active' : ''}">Goes back to divvy</button>
      </div>
      <input type="hidden" name="rollover" value="${c.rollover === 'pool' ? 'pool' : 'keep'}" />
      ${rolloverOn() ? '' : '<p class="muted" style="margin:-4px 0 0;font-size:.8rem">Carry-over is turned off in Settings, so nothing moves to next month right now.</p>'}
      <label class="field">Color</label>
      <div class="swatches">${PALETTE.map((p) => `<button type="button" class="swatch ${p === color ? 'active' : ''}" data-color="${p}" style="background:${p}" aria-label="Color ${p}"></button>`).join('')}</div>
      <input type="hidden" name="color" value="${color}" />
      <div class="btn-row ${c.id ? 'split' : 'end'}">
        ${c.id ? `<button type="button" class="btn danger" data-action="delete-cat" data-id="${c.id}">Delete</button>` : ''}
        <button type="submit" class="btn gold">${c.id ? 'Save changes' : 'Add category'}</button>
      </div>
    </form>`;
  }

  function viewSettings() {
    const st = state.settings;
    const currencies = [['USD', 'US Dollar'], ['CAD', 'Canadian Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound'], ['AUD', 'Australian Dollar'], ['MXN', 'Mexican Peso']];
    const saved = state.updatedAt ? new Date(state.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet';
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    return `
    <div class="grid grid-2-even">
      <div class="stack">
        <section class="card">
          <h3>You</h3>
          <p class="sub">Little things that make it yours.</p>
          <form class="form" data-form="settings">
            <label class="field">Your name<input class="input" name="name" maxlength="30" value="${esc(st.name)}" placeholder="for the greeting" /></label>
            <label class="field">Currency<select class="input" name="currency">${currencies.map(([c, n]) => `<option value="${c}" ${c === st.currency ? 'selected' : ''}>${n} (${c})</option>`).join('')}</select></label>
            <label class="toggle-row">
              <input type="checkbox" name="rollover" ${rolloverOn() ? 'checked' : ''} />
              <span><b>Carry leftovers into next month</b><br><span class="muted">Unassigned income and unused category money roll forward. Overspending carries too, so the numbers stay honest.</span></span>
            </label>
            <label class="field">Income sources <span class="muted" style="font-weight:400">— one per line</span><textarea class="input" name="sources" rows="4">${esc(st.sources.join('\n'))}</textarea></label>
            <div class="btn-row end"><button class="btn gold" type="submit">Save</button></div>
          </form>
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <h3>Your data</h3>
          <p class="sub">Everything is saved automatically on this device — close the tab, come back anytime. Last saved: <b>${esc(saved)}</b>.</p>
          ${standalone ? '<div class="notice sage">You\'re using FlexBudget from your home screen — perfect. 🌿</div>'
            : `<div class="notice"><b>On iPhone?</b> Open this site in Safari, tap the Share button, then <b>Add to Home Screen</b>. It opens like an app, and iOS won't clear your data after a week away.</div>`}
          <hr class="divider" />
          <p class="eyebrow">Backups</p>
          <p class="muted" style="font-size:.88rem;margin:0 0 12px">A backup file lets you move to a new phone or browser, or recover if browser data gets cleared.</p>
          <div class="btn-row">
            <button class="btn sage" data-action="export">Download backup</button>
            <label class="btn ghost" style="cursor:pointer">Restore backup<input type="file" accept="application/json,.json" data-action="import" hidden /></label>
          </div>
        </section>
        <section class="card">
          <h3>Start fresh</h3>
          <p class="sub">Erase everything saved in this browser. Download a backup first if you might want it.</p>
          <button class="btn danger" data-action="reset">Erase all data</button>
        </section>
      </div>
    </div>`;
  }

  // ---------- render ----------
  const views = { overview: viewOverview, income: viewIncome, bills: viewBills, categories: viewCategories, settings: viewSettings };
  function render({ animate = false } = {}) {
    resetMemo();
    renderHeader();
    const v = $('#view');
    v.innerHTML = views[ui.tab]();
    if (animate) { v.classList.remove('view-enter'); void v.offsetWidth; v.classList.add('view-enter'); }
    $('#fab').hidden = ui.tab === 'settings';
  }
  function goTab(tab) {
    ui.tab = tab;
    history.replaceState(null, '', '#' + tab);
    render({ animate: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- actions ----------
  function openIncome(t) {
    openSheet(t && t.id ? 'Edit income' : 'Money in', incomeForm(t || {}, 'sheet'), null);
  }
  function openSpend(t) {
    openSheet(t && t.id ? 'Edit spending' : 'Money out', spendForm(t || {}), null);
  }
  function openEntryChooser() {
    openSheet('Add', `<div class="seg" style="margin-bottom:16px"><button type="button" class="active" data-entry="in">Money in</button><button type="button" data-entry="out">Money out</button></div><div data-entry-body>${incomeForm({}, 'sheet')}</div>`);
  }

  function saveIncome(fd, form) {
    const amount = parseAmount(fd.get('amount'));
    if (!(amount > 0)) return toast('Enter an amount above zero.');
    const id = form.dataset.editId;
    const data = { amount, date: fd.get('date') || todayISO(), source: fd.get('source') || 'Income', note: String(fd.get('note') || '').trim() };
    let msg;
    if (id) {
      Object.assign(state.income.find((x) => x.id === id), data);
      msg = 'Income updated.';
    } else {
      const lines = splitPreview(data.date.slice(0, 7), amount);
      state.income.push({ id: uid(), createdAt: new Date().toISOString(), ...data });
      msg = `+${money(amount)} added` + (lines.length ? ' → ' + lines.slice(0, 3).map((l) => `${l.label} ${money(l.amount)}`).join(' · ') : '');
    }
    save();
    if (data.date.slice(0, 7) !== ui.month) ui.month = data.date.slice(0, 7);
    closeSheet();
    render();
    toast(msg);
  }

  function saveSpend(fd, form) {
    const amount = parseAmount(fd.get('amount'));
    if (!(amount > 0)) return toast('Enter an amount above zero.');
    const id = form.dataset.editId;
    const data = { amount, date: fd.get('date') || todayISO(), categoryId: fd.get('categoryId') || '', note: String(fd.get('note') || '').trim() };
    if (id) Object.assign(state.spending.find((x) => x.id === id), data);
    else state.spending.push({ id: uid(), createdAt: new Date().toISOString(), ...data });
    save();
    if (data.date.slice(0, 7) !== ui.month) ui.month = data.date.slice(0, 7);
    closeSheet();
    render();
    const c = catById(data.categoryId);
    if (c) {
      const s = summary(ui.month);
      const left = s.balance[c.id] || 0;
      toast(left >= 0 ? `${money(left)} left in ${c.name}.` : `${c.name} is ${money(-left)} over for the month.`);
    } else toast('Spending saved.');
  }

  function saveBill(fd, form) {
    const name = String(fd.get('name') || '').trim();
    const amount = parseAmount(fd.get('amount'));
    if (!name) return toast('Give the bill a name.');
    const dueDay = Math.min(31, Math.max(0, parseInt(fd.get('dueDay'), 10) || 0)) || null;
    const id = form.dataset.editId;
    if (id) Object.assign(state.bills.find((b) => b.id === id), { name, amount, dueDay });
    else state.bills.push({ id: uid(), name, amount, dueDay, from: ui.month });
    save(); closeSheet(); render();
    toast(id ? 'Bill updated.' : `${name} added to your monthly bills.`);
  }

  function saveCat(fd, form) {
    const name = String(fd.get('name') || '').trim();
    if (!name) return toast('Give the category a name.');
    const mode = fd.get('mode');
    let value = 0;
    if (mode === 'percent') { value = r2(fd.get('percent')); if (value <= 0 || value > 100) return toast('Choose a percent between 0 and 100.'); }
    if (mode === 'fixed') { value = parseAmount(fd.get('fixed')); if (!(value > 0)) return toast('Enter the monthly amount.'); }
    const color = fd.get('color') || PALETTE[0];
    const rollover = fd.get('rollover') === 'pool' ? 'pool' : 'keep';
    const id = form.dataset.editId;
    if (id) Object.assign(catById(id), { name, mode, value, color, rollover });
    else state.categories.push({ id: uid(), name, mode, value, color, rollover });
    save(); closeSheet(); render();
    toast(id ? 'Category updated.' : `${name} created.`);
  }

  function starterCats() {
    const set = [
      { name: 'Taxes set-aside', mode: 'percent', value: 20 },
      { name: 'Savings', mode: 'percent', value: 15 },
      { name: 'Salon supplies', mode: 'percent', value: 5 },
      { name: 'Groceries', mode: 'fixed', value: 300 },
      { name: 'Fun money', mode: 'leftover', value: 0 },
    ];
    set.forEach((c, i) => state.categories.push({ id: uid(), color: PALETTE[i % PALETTE.length], ...c }));
    save(); render();
    toast('Starter categories added — tap any to change it.');
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `flexbudget-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Backup downloaded.');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch { return toast('That file isn\'t a FlexBudget backup.'); }
      if (!data || typeof data !== 'object' || !Array.isArray(data.categories) || !Array.isArray(data.income)) return toast('That file isn\'t a FlexBudget backup.');
      confirmSheet('Restore backup?', 'This replaces everything currently saved here with the backup file.', 'Replace my data', () => {
        state = migrate(data); save(); render(); toast('Backup restored. Welcome back!');
      });
    };
    reader.readAsText(file);
  }

  // ---------- events ----------
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) goTab(b.dataset.tab); });
  $('#prevMonth').addEventListener('click', () => { ui.month = shiftMonth(ui.month, -1); render({ animate: true }); });
  $('#nextMonth').addEventListener('click', () => { ui.month = shiftMonth(ui.month, 1); render({ animate: true }); });
  $('#todayBtn').addEventListener('click', () => { ui.month = thisMonth(); render({ animate: true }); });
  $('#fab').addEventListener('click', () => {
    if (ui.tab === 'income') openIncome();
    else if (ui.tab === 'categories') openSpend();
    else if (ui.tab === 'bills') openSheet('Add a bill', billForm({}));
    else openEntryChooser();
  });

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-tab-go]');
    if (go) { closeSheet(); return goTab(go.dataset.tabGo); }

    // segmented control: entry chooser
    const entry = e.target.closest('[data-entry]');
    if (entry) {
      $$('[data-entry]').forEach((b) => b.classList.toggle('active', b === entry));
      $('[data-entry-body]').innerHTML = entry.dataset.entry === 'in' ? incomeForm({}, 'sheet') : spendForm({});
      const f = $('[data-entry-body] [autofocus]'); if (f) f.focus();
      return;
    }
    // segmented control: category mode
    const modeBtn = e.target.closest('[data-seg="mode"] button');
    if (modeBtn) {
      const form = modeBtn.closest('form');
      $$('[data-seg="mode"] button', form).forEach((b) => b.classList.toggle('active', b === modeBtn));
      form.elements.mode.value = modeBtn.dataset.mode;
      $$('[data-mode-field]', form).forEach((el) => { el.hidden = el.dataset.modeField !== modeBtn.dataset.mode; });
      return;
    }
    const rollBtn = e.target.closest('[data-seg="roll"] button');
    if (rollBtn) {
      const form = rollBtn.closest('form');
      $$('[data-seg="roll"] button', form).forEach((b) => b.classList.toggle('active', b === rollBtn));
      form.elements.rollover.value = rollBtn.dataset.roll;
      return;
    }
    const sw = e.target.closest('.swatch');
    if (sw) {
      const form = sw.closest('form');
      $$('.swatch', form).forEach((b) => b.classList.toggle('active', b === sw));
      form.elements.color.value = sw.dataset.color;
      return;
    }
    const chip = e.target.closest('label.chip');
    if (chip) {
      $$('label.chip', chip.parentElement).forEach((c) => c.classList.toggle('active', c === chip));
      return;
    }

    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'add-income': openIncome(); break;
      case 'add-spend': openSpend(); break;
      case 'edit-income': {
        const t = state.income.find((x) => x.id === id);
        if (t) { openIncome(t); $('#sheetBody form').dataset.editId = id; }
        break;
      }
      case 'edit-spend': {
        const t = state.spending.find((x) => x.id === id);
        if (t) { openSpend(t); const f = $('#sheetBody form'); if (f) f.dataset.editId = id; }
        break;
      }
      case 'delete-income':
        state.income = state.income.filter((x) => x.id !== id); save(); closeSheet(); render(); toast('Income deleted.'); break;
      case 'delete-spend':
        state.spending = state.spending.filter((x) => x.id !== id); save(); closeSheet(); render(); toast('Spending deleted.'); break;
      case 'toggle-paid': {
        const list = new Set(state.paid[ui.month] || []);
        list.has(id) ? list.delete(id) : list.add(id);
        state.paid[ui.month] = [...list];
        save(); render();
        break;
      }
      case 'edit-bill': {
        const b = state.bills.find((x) => x.id === id);
        if (b) { openSheet('Edit bill', billForm(b)); $('#sheetBody form').dataset.editId = id; }
        break;
      }
      case 'delete-bill': {
        const b = state.bills.find((x) => x.id === id);
        if (!b) break;
        confirmSheet('Remove this bill?', `<b>${esc(b.name)}</b> will stop showing up from ${esc(monthName(ui.month))} on. Earlier months keep their history.`, 'Remove bill', () => {
          const until = shiftMonth(ui.month, -1);
          if (!b.from || until < b.from) {
            state.bills = state.bills.filter((x) => x.id !== id);
            Object.keys(state.paid).forEach((m) => { state.paid[m] = state.paid[m].filter((x) => x !== id); });
          } else b.until = until;
          save(); render(); toast('Bill removed.');
        });
        break;
      }
      case 'edit-cat': {
        const c = catById(id);
        if (c) { openSheet('Edit category', catForm(c)); $('#sheetBody form').dataset.editId = id; }
        break;
      }
      case 'delete-cat': {
        const c = catById(id);
        if (!c) break;
        const n = state.spending.filter((s) => s.categoryId === id).length;
        confirmSheet('Delete category?', `<b>${esc(c.name)}</b> will be removed.${n ? ` Its ${n} spending entr${n === 1 ? 'y' : 'ies'} will stay, marked “Uncategorized”.` : ''}`, 'Delete', () => {
          state.categories = state.categories.filter((x) => x.id !== id);
          if (ui.spendFilter === id) ui.spendFilter = 'all';
          save(); render(); toast('Category deleted.');
        });
        break;
      }
      case 'move-cat': {
        const i = state.categories.findIndex((c) => c.id === id);
        const j = i + Number(el.dataset.dir);
        if (i < 0 || j < 0 || j >= state.categories.length) break;
        [state.categories[i], state.categories[j]] = [state.categories[j], state.categories[i]];
        save(); render();
        break;
      }
      case 'filter-cat':
        ui.spendFilter = id;
        if (ui.tab !== 'categories') goTab('categories'); else render();
        break;
      case 'starter-cats': starterCats(); break;
      case 'export': exportData(); break;
      case 'reset':
        confirmSheet('Erase everything?', 'All income, bills, categories and spending saved in this browser will be permanently erased.', 'Erase all data', () => {
          localStorage.removeItem(KEY); state = defaults(); state.settings.onboarded = true; save(); ui.month = thisMonth(); render(); toast('All cleared. Fresh start ✨');
        });
        break;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('input[type=file][data-action="import"]') && e.target.files[0]) {
      importData(e.target.files[0]);
      e.target.value = '';
    }
  });

  // live split preview while typing an income amount
  document.addEventListener('input', (e) => {
    const form = e.target.closest('form[data-form="income"]');
    if (!form || form.dataset.editId) return;
    const box = $('[data-split]', form);
    if (!box) return;
    const amount = parseAmount(form.elements.amount.value);
    const m = (form.elements.date.value || defaultDateFor(ui.month)).slice(0, 7);
    const lines = amount > 0 ? splitPreview(m, amount) : [];
    box.hidden = !lines.length;
    box.innerHTML = lines.length ? `<h4>How this divvies up</h4>${lines.map((l) => `<div class="split-line"><span><i class="dot" style="background:${l.color}"></i> ${esc(l.label)}</span><b>${money(l.amount)}</b></div>`).join('')}` : '';
  });

  // forms in the main view (inline) + sheet forms share these handlers
  const handlers = {
    income: saveIncome,
    spend: saveSpend,
    bill: saveBill,
    cat: saveCat,
    goal: (fd) => { state.settings.incomeGoal = parseAmount(fd.get('goal')); save(); render(); toast('Goal saved.'); },
    settings: (fd) => {
      state.settings.name = String(fd.get('name') || '').trim();
      state.settings.currency = fd.get('currency') || 'USD';
      state.settings.rollover = fd.get('rollover') === 'on';
      const src = String(fd.get('sources') || '').split('\n').map((s) => s.trim()).filter(Boolean);
      state.settings.sources = src.length ? [...new Set(src)] : ['Income'];
      save(); render(); toast('Saved.');
    },
    welcome: (fd) => {
      state.settings.name = String(fd.get('name') || '').trim();
      state.settings.onboarded = true;
      save(); closeSheet(); render();
    },
  };
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const h = handlers[form.dataset.form];
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    h(new FormData(form), form);
  }, true);

  // ---------- first visit ----------
  function welcome() {
    state.settings.onboarded = true;
    save();
    openSheet('Welcome to FlexBudget', `
      <form class="form" data-form="welcome">
        <p style="margin:0;color:var(--ink-2)">A gentle budget made for income that changes month to month.</p>
        <ul style="margin:0;padding-left:18px;color:var(--ink-2);font-size:.92rem;display:grid;gap:4px">
          <li><b>Log income</b> as clients and tips come in</li>
          <li><b>Add fixed bills</b> once — they repeat every month</li>
          <li><b>Divvy up the rest</b> into categories you choose</li>
        </ul>
        <div class="notice sage">Everything saves privately on this device. No account, no password — just come back anytime.</div>
        <label class="field">What should we call you?<input class="input" name="name" maxlength="30" placeholder="Your first name" autofocus /></label>
        <button class="btn gold block" type="submit">Let's begin</button>
      </form>`);
  }

  // ---------- boot ----------
  garlandW = window.innerWidth;
  drawGarland();
  render();
  if (!state.settings.onboarded && !state.income.length && !state.categories.length) welcome();
  // re-render at midnight-ish / when coming back to the tab so "today" stays right
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { state = load(); render(); } });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
