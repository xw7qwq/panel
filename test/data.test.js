import assert from 'node:assert/strict';
import test from 'node:test';
import { healthMetrics, healthSeries, publicHealth, validateHealthSnapshot } from '../worker/health.js';
import { HttpError } from '../worker/http.js';
import { ledgerBalances, ledgerMonthly, ledgerSummary, ledgerTransactions, monthSummary, validateLedgerSnapshot } from '../worker/ledger.js';
import { publicOj } from '../worker/oj.js';
import { healthSnapshot, ledgerSnapshot } from './_helpers.js';

test('public health summary covers the 7 days before today in UTC+8', () => {
  // 2026-03-10 01:00 UTC+8：今天是 3 月 10 日，窗口是 3 月 3 日到 9 日。
  const summary = publicHealth(healthSnapshot(), Date.parse('2026-03-09T17:00:00Z'));
  assert.deepEqual(summary, {
    as_of: '2026-03-09',
    window_days: 7,
    sleep_hours_avg7: 6.6,
    steps_avg7: 6000,
    days_with_data: 7,
    generated_at: '2026-03-10T08:00:00Z',
  });
});

test('public health summary handles missing data without inventing zeros', () => {
  const summary = publicHealth(healthSnapshot({ daily: { metrics: [], points: [] } }), Date.parse('2026-03-09T17:00:00Z'));
  assert.equal(summary.sleep_hours_avg7, null);
  assert.equal(summary.steps_avg7, null);
  assert.equal(summary.days_with_data, 0);
});

test('health snapshot validation', () => {
  assert.ok(validateHealthSnapshot(healthSnapshot()));
  assert.throws(() => validateHealthSnapshot({ schema_version: 2 }), HttpError);
  assert.throws(() => validateHealthSnapshot(healthSnapshot({ daily: undefined })), /daily/);
  assert.throws(() => validateHealthSnapshot(healthSnapshot({ weekly: { points: [] } })), /weekly/);
  assert.throws(() => validateHealthSnapshot(healthSnapshot({ sleep: {} })), /sleep/);
});

test('health metrics and series keep only known fields and requested metrics', () => {
  const [card] = healthMetrics(healthSnapshot());
  assert.equal(card.key, 'steps');
  assert.equal('extra' in card, false);
  const series = healthSeries(healthSnapshot(), { metrics: ['steps', 'missing'], limit: 2 });
  assert.deepEqual(series.points, [
    { date: '2026-03-09', steps: 9000 },
    { date: '2026-03-10', steps: 10000 },
  ]);
  assert.deepEqual(healthSeries(healthSnapshot(), { granularity: 'weekly', limit: 1 }).points, [{ period: '2026-W10', steps: 8000 }]);
  assert.deepEqual(healthSeries({}, { granularity: 'weekly' }).points, []);
});

test('ledger month summary uses beancount signs', () => {
  const march = monthSummary(ledgerSnapshot(), '2026-03');
  assert.equal(march.income, 7000);
  assert.equal(march.expenses, 3700.75);
  assert.equal(march.net, 3299.25);
  assert.equal(march.savings_rate, 47.1);
  assert.deepEqual(march.categories, [
    { account: 'Expenses:Rent', amount: 2500 },
    { account: 'Expenses:Food', amount: 1200.75 },
  ]);
  assert.equal(monthSummary(ledgerSnapshot(), '2025-01').savings_rate, null);
});

test('ledger summary picks the latest month and totals balances', () => {
  const summary = ledgerSummary(ledgerSnapshot());
  assert.equal(summary.month.month, '2026-03');
  assert.equal(summary.previous_month.month, '2026-02');
  assert.equal(summary.assets, 1200);
  assert.equal(summary.liabilities, -300);
  assert.equal(summary.net_worth, 900);
  assert.equal(ledgerSummary(ledgerSnapshot(), '2026-02').previous_month, null);
});

test('ledger monthly, balances and transactions filter by account prefix', () => {
  const monthly = ledgerMonthly(ledgerSnapshot(), { prefix: 'Expenses:Food', depth: 2, last: 1 });
  assert.deepEqual(monthly.months, ['2026-03']);
  assert.deepEqual(monthly.rows, [{ month: '2026-03', account: 'Expenses:Food', amount: 1200.75 }]);
  assert.equal(ledgerMonthly(ledgerSnapshot(), { prefix: 'Expenses:Foo' }).rows.length, 0);
  assert.deepEqual(ledgerBalances(ledgerSnapshot(), { prefix: 'Assets' }).map((row) => row.account), ['Assets:Bank:Checking', 'Assets:Cash']);
  assert.deepEqual(ledgerTransactions(ledgerSnapshot(), { account: 'Expenses:Food' }).map((entry) => entry.payee), ['盒马', '食堂']);
  assert.deepEqual(ledgerTransactions(ledgerSnapshot(), { since: '2026-03-01', text: '午饭' }).map((entry) => entry.payee), ['食堂']);
  assert.equal(ledgerTransactions(ledgerSnapshot(), { limit: 1 }).length, 1);
});

test('ledger snapshot validation', () => {
  assert.ok(validateLedgerSnapshot(ledgerSnapshot()));
  assert.throws(() => validateLedgerSnapshot(ledgerSnapshot({ balances: null })), /balances/);
  assert.throws(() => validateLedgerSnapshot(ledgerSnapshot({ currency: '' })), /currency/);
});

test('public oj summary trims history to about a year and five recent solves', () => {
  const daily = { '2025-01-01': 3, '2026-02-28': 2, '2026-03-01': 1 };
  const recent = Array.from({ length: 8 }, (_, index) => ({ title: `p${index}` }));
  const result = publicOj({ generated_at: 'x', today: '2026-03-01', solved: 10, daily, recent, monthly: { '2026-03': { total: 1 } } });
  assert.deepEqual(result.daily, { '2026-02-28': 2, '2026-03-01': 1 });
  assert.equal(result.recent.length, 5);
  assert.equal('monthly' in result, false);
  assert.equal(publicOj(null), null);
});
