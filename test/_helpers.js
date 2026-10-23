// 测试用的假 KV 和固定数据。
export function memoryKv() {
  const store = new Map();
  return {
    store,
    writes: 0,
    async get(key, type) {
      const entry = store.get(key);
      if (entry === undefined) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    },
    async getWithMetadata(key, type) {
      const entry = store.get(key);
      if (entry === undefined) return { value: null, metadata: null };
      const value = type === 'stream' ? new Response(entry.value).body : await this.get(key, type);
      return { value, metadata: entry.metadata };
    },
    async put(key, value, options = {}) {
      this.writes++;
      store.set(key, { value, metadata: options.metadata ?? null });
    },
  };
}

export function healthSnapshot(overrides = {}) {
  const points = [];
  for (let day = 1; day <= 10; day++) {
    const date = `2026-03-${String(day).padStart(2, '0')}`;
    points.push({ date, sleep_hours: 6 + day / 10, steps: 1000 * day, hrv: null });
  }
  return {
    schema_version: 1,
    generated_at: '2026-03-10T08:00:00Z',
    metrics: [{ key: 'steps', label: '步数', unit: '步', tone: 'green', latest: 10000, latest_date: '2026-03-10', avg7: 7000, avg30: 5500, goal: 8000, trend: { assessment: 'improving', percent: 12 }, extra: 'dropped' }],
    daily: { metrics: [{ key: 'sleep_hours', label: '睡眠时长', unit: '小时' }, { key: 'steps', label: '步数', unit: '步' }, { key: 'hrv', label: 'HRV', unit: 'ms' }], points },
    weekly: { metrics: [{ key: 'steps', label: '步数', unit: '步' }], points: [{ period: '2026-W09', steps: 4000 }, { period: '2026-W10', steps: 8000 }] },
    sleep: [],
    ...overrides,
  };
}

export function ledgerSnapshot(overrides = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-03-31T23:00:00Z',
    as_of: '2026-03-31',
    currency: 'CNY',
    accounts: [],
    balances: [
      { account: 'Assets:Bank:Checking', amount: 1000.004 },
      { account: 'Assets:Cash', amount: 200 },
      { account: 'Liabilities:CreditCard', amount: -300 },
    ],
    monthly: [
      { month: '2026-02', account: 'Income:Salary', amount: -5000 },
      { month: '2026-02', account: 'Expenses:Food:Dining', amount: 800 },
      { month: '2026-03', account: 'Income:Salary', amount: -6000 },
      { month: '2026-03', account: 'Income:Bonus', amount: -1000 },
      { month: '2026-03', account: 'Expenses:Food:Dining', amount: 900.5 },
      { month: '2026-03', account: 'Expenses:Food:Groceries', amount: 300.25 },
      { month: '2026-03', account: 'Expenses:Rent', amount: 2500 },
    ],
    net_worth: [
      { date: '2026-02-28', assets: 1000, liabilities: -200, net: 800 },
      { date: '2026-03-31', assets: 1200.004, liabilities: -300, net: 900.004 },
    ],
    transactions: [
      { date: '2026-03-30', payee: '盒马', narration: '买菜', tags: ['home'], postings: [{ account: 'Expenses:Food:Groceries', amount: 80, currency: 'CNY' }, { account: 'Liabilities:CreditCard', amount: -80, currency: 'CNY' }] },
      { date: '2026-03-20', payee: '食堂', narration: '午饭', tags: [], postings: [{ account: 'Expenses:Food:Dining', amount: 25, currency: 'CNY' }, { account: 'Assets:Cash', amount: -25, currency: 'CNY' }] },
      { date: '2026-02-10', payee: '房东', narration: '房租', tags: [], postings: [{ account: 'Expenses:Rent', amount: 2500, currency: 'CNY' }, { account: 'Assets:Bank:Checking', amount: -2500, currency: 'CNY' }] },
    ],
    ...overrides,
  };
}

export const ORIGIN = 'https://lucius7.dev';

export function request(path, init = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}
