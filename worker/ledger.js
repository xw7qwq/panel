import { HttpError } from './http.js';

// 记账快照由服务器上的 ledger 推送（schema_version 1）。金额已按主币种（operating_currency）折算；
// monthly 里的金额沿用 beancount 的符号：收入为负、支出为正。
export function validateLedgerSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || payload.schema_version !== 1) throw new HttpError(400, 'invalid_snapshot', 'schema_version 必须是 1');
  for (const key of ['accounts', 'balances', 'monthly', 'net_worth', 'transactions']) {
    if (!Array.isArray(payload[key])) throw new HttpError(400, 'invalid_snapshot', `${key} 必须是数组`);
  }
  if (typeof payload.currency !== 'string' || !payload.currency) throw new HttpError(400, 'invalid_snapshot', '缺少 currency');
  if (payload.transactions.length > 5000) throw new HttpError(400, 'invalid_snapshot', 'transactions 最多 5000 条');
  return payload;
}

const round2 = (value) => Math.round(value * 100) / 100;

export function accountAt(account, depth) {
  return account.split(':').slice(0, depth).join(':');
}

export function months(snapshot) {
  return [...new Set(snapshot.monthly.map((row) => row.month))].sort();
}

// 某个月的收入、支出、结余和支出构成（按二级账户合并）。
export function monthSummary(snapshot, month) {
  let income = 0;
  let expenses = 0;
  const categories = new Map();
  for (const row of snapshot.monthly) {
    if (row.month !== month) continue;
    if (row.account.startsWith('Income')) income -= row.amount;
    if (row.account.startsWith('Expenses')) {
      expenses += row.amount;
      const key = accountAt(row.account, 2);
      categories.set(key, (categories.get(key) || 0) + row.amount);
    }
  }
  return {
    month,
    income: round2(income),
    expenses: round2(expenses),
    net: round2(income - expenses),
    savings_rate: income > 0 ? Math.round(((income - expenses) / income) * 1000) / 10 : null,
    categories: [...categories]
      .map(([account, amount]) => ({ account, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

export function ledgerSummary(snapshot, month = null) {
  const all = months(snapshot);
  const current = month && all.includes(month) ? month : all.at(-1) ?? null;
  const previous = current ? all[all.indexOf(current) - 1] ?? null : null;
  const worth = snapshot.net_worth.at(-1) ?? null;
  const totals = { Assets: 0, Liabilities: 0 };
  for (const row of snapshot.balances) {
    const top = row.account.split(':')[0];
    if (top in totals) totals[top] += row.amount;
  }
  return {
    currency: snapshot.currency,
    as_of: snapshot.as_of ?? null,
    generated_at: snapshot.generated_at ?? null,
    month: current ? monthSummary(snapshot, current) : null,
    previous_month: previous ? monthSummary(snapshot, previous) : null,
    assets: round2(totals.Assets),
    liabilities: round2(totals.Liabilities),
    net_worth: worth ? round2(worth.net) : round2(totals.Assets + totals.Liabilities),
  };
}

// 按月汇总：prefix 过滤账户（如 Expenses:Food），depth 决定合并到第几级。
export function ledgerMonthly(snapshot, { prefix = '', depth = 2, last = 12 } = {}) {
  const wanted = months(snapshot).slice(-last);
  const keep = new Set(wanted);
  const table = new Map();
  for (const row of snapshot.monthly) {
    if (!keep.has(row.month) || (prefix && !(row.account === prefix || row.account.startsWith(`${prefix}:`)))) continue;
    const account = accountAt(row.account, depth);
    const key = `${row.month}\u0000${account}`;
    table.set(key, (table.get(key) || 0) + row.amount);
  }
  return {
    currency: snapshot.currency,
    months: wanted,
    rows: [...table]
      .map(([key, amount]) => {
        const [month, account] = key.split('\u0000');
        return { month, account, amount: round2(amount) };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || a.account.localeCompare(b.account)),
  };
}

export function ledgerBalances(snapshot, { prefix = '' } = {}) {
  return snapshot.balances
    .filter((row) => !prefix || row.account === prefix || row.account.startsWith(`${prefix}:`))
    .map((row) => ({ account: row.account, amount: round2(row.amount) }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

export function ledgerTransactions(snapshot, { since = null, account = '', text = '', limit = 50 } = {}) {
  const needle = text.trim().toLowerCase();
  const result = [];
  for (const entry of snapshot.transactions) {
    if (since && entry.date < since) continue;
    if (account && !entry.postings.some((posting) => posting.account === account || posting.account.startsWith(`${account}:`))) continue;
    if (needle && !`${entry.payee || ''} ${entry.narration || ''} ${(entry.tags || []).join(' ')}`.toLowerCase().includes(needle)) continue;
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}
