import assert from 'node:assert/strict';
import test from 'node:test';
import { activeDashboard, completion, contestMatrix, cumulative, dailyCounts, epochDay, firstAccepted, matchesStatus, streaks } from '../src/lib/oj.js';

// 这些规则原来由 oj 仓库的页面（public/model.js）实现和测试，页面并入面板后测试跟着搬过来。
const event = (id, problemId, time) => ({ id, problemId, epoch: Date.parse(time) / 1000 });
const total = (counts) => Object.values(counts).reduce((sum, count) => sum + count, 0);

test('AC dates use UTC+8 midnight', () => {
  assert.equal(epochDay(Date.parse('2026-09-07T15:59:59Z') / 1000), '2026-09-07');
  assert.equal(epochDay(Date.parse('2026-09-07T16:00:00Z') / 1000), '2026-09-08');
});

test('first AC deduplicates by platform problem id, not by title or submission id', () => {
  const events = [
    { id: 8, problemId: 'atcoder:abc001_a', epoch: 1720000000 },
    { id: 2, problemId: 'atcoder:abc001_a', epoch: 1710000000 },
    { id: 2, problemId: 'codeforces:1:A', epoch: 1710000000 },
    { id: 1, problemId: 'atcoder:abc001_a', epoch: 1710000000 },
    { id: 1, problemId: 'nowcoder:321116', epoch: 1710000000 },
  ];
  const first = firstAccepted(events);
  assert.equal(first.size, 3);
  assert.equal(first.get('atcoder:abc001_a').id, 1);
  assert.equal(total(dailyCounts([...first.values()])), 3);
  assert.equal(total(dailyCounts(events)), 5);
});

test('the cumulative curve counts first ACs, carries earlier solves forward and stops at the end date', () => {
  const events = [
    event(5, 'qoj:future', '2026-01-03T16:00:00Z'),
    event(4, 'qoj:1', '2026-01-01T16:00:00Z'),
    event(3, 'atcoder:a', '2026-01-01T08:00:00Z'),
    event(2, 'codeforces:1:A', '2025-12-31T16:00:00Z'),
    event(1, 'atcoder:a', '2025-12-31T15:59:59Z'),
  ];
  assert.deepEqual(cumulative(dailyCounts([...firstAccepted(events).values()]), '2026-01-01', '2026-01-03'), [
    { x: '2026-01-01', y: 2 },
    { x: '2026-01-02', y: 3 },
    { x: '2026-01-03', y: 3 },
  ]);
});

test('the cumulative curve includes leap days and stays flat on inactive days', () => {
  assert.deepEqual(cumulative({}, '2024-02-28', '2024-03-01'), [
    { x: '2024-02-28', y: 0 },
    { x: '2024-02-29', y: 0 },
    { x: '2024-03-01', y: 0 },
  ]);
  const counts = dailyCounts([event(1, 'atcoder:a', '2023-01-01T00:00:00Z')]);
  assert.equal(cumulative(counts, '2024-02-28', '2024-03-01').at(-1).y, 1);
});

test('a streak may end yesterday, ignores future days and crosses year boundaries', () => {
  const dates = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-04', '2026-01-04', '2026-01-08'];
  assert.deepEqual(streaks(dates, '2026-01-02'), { current: 3, longest: 3 });
  assert.deepEqual(streaks(dates, '2026-01-06'), { current: 0, longest: 3 });
  assert.deepEqual(streaks([], '2026-01-06'), { current: 0, longest: 0 });
});

test('disabled Luogu data and contests without submissions are left out', () => {
  const original = {
    sources: { atcoder: {}, luogu: {}, nowcoder: {} },
    problems: [{ id: 'atcoder:task', platform: 'atcoder' }, { id: 'luogu:P1', platform: 'luogu' }, { id: 'nowcoder:1', platform: 'nowcoder' }],
    accepted: [{ id: 1, platform: 'atcoder', problemId: 'atcoder:task', epoch: 100 }, { id: 2, platform: 'luogu', problemId: 'luogu:P1', epoch: 100 }],
    attempted: ['atcoder:task', 'luogu:P1', 'nowcoder:1'],
    undatedSolved: ['luogu:P1'],
    contests: [
      { id: 'qoj:1', platform: 'qoj', hasSubmissions: true },
      { id: 'qoj:2', platform: 'qoj', hasSubmissions: false },
      { id: 'qoj:3', platform: 'qoj' },
      { id: 'atcoder:abc001', platform: 'atcoder', hasSubmissions: false },
      { id: 'atcoder:abc002', platform: 'atcoder', hasSubmissions: true },
      { id: 'codeforces:2', platform: 'codeforces', hasSubmissions: 1 },
      { id: 'codeforces:3', platform: 'codeforces', hasSubmissions: 'true' },
      { id: 'luogu:1', platform: 'luogu', hasSubmissions: true },
    ],
  };
  const data = activeDashboard(original);
  assert.deepEqual(Object.keys(data.sources), ['atcoder', 'nowcoder']);
  assert.deepEqual(data.problems.map((problem) => problem.id), ['atcoder:task', 'nowcoder:1']);
  assert.deepEqual(data.accepted.map((item) => item.problemId), ['atcoder:task']);
  assert.deepEqual(data.attempted, ['atcoder:task', 'nowcoder:1']);
  assert.deepEqual(data.undatedSolved, []);
  assert.deepEqual(data.contests.map((contest) => contest.id), ['qoj:1', 'atcoder:abc002']);
  assert.equal(original.problems.length, 3);
});

test('an unknown Gym denominator never counts as a completed contest', () => {
  const first = new Map([['codeforces:100001:A', {}]]);
  const attempted = new Set(['codeforces:100001:A']);
  const partial = completion({ problems: ['codeforces:100001:A'], catalogComplete: false }, first, attempted);
  assert.deepEqual(partial, { solved: 1, total: 1, started: true, complete: false });
  assert.equal(matchesStatus(partial, 'completed'), false);
  assert.equal(matchesStatus(partial, 'unfinished'), true);
  assert.equal(completion({ problems: ['codeforces:100001:A'], catalogComplete: true }, first, attempted).complete, true);
  assert.equal(completion({ problems: ['codeforces:100001:B'], catalogComplete: true }, first, attempted).started, false);
});

test('a shared AtCoder task shows as solved without inventing a contest submission', () => {
  const first = new Map([['atcoder:abc001_a', {}]]);
  const attempted = new Set(['atcoder:abc001_a']);
  const reused = completion({ problems: ['atcoder:abc001_a'], catalogComplete: true, hasSubmissions: false }, first, attempted);
  assert.equal(reused.solved, 1);
  assert.equal(reused.started, false);
  assert.equal(matchesStatus(reused, 'unfinished'), false);
  const original = completion({ problems: ['atcoder:abc001_a'], catalogComplete: true, hasSubmissions: true }, first, attempted);
  assert.equal(original.started, true);
});

test('the contest matrix aligns contest-local labels, split problems and AtCoder H / Ex', () => {
  const problems = new Map([
    ['atcoder:shared', { index: 'D' }],
    ['atcoder:ex', { index: 'Ex' }],
    ['codeforces:a1', { index: 'A1' }],
    ['codeforces:a2', { index: 'A2' }],
    ['codeforces:h', { index: 'H' }],
  ]);
  const contests = [
    { id: 'atcoder:1', problems: ['atcoder:shared', 'atcoder:ex', 'atcoder:missing'], problemIndices: { 'atcoder:shared': 'A' } },
    { id: 'codeforces:1', problems: ['codeforces:a1', 'codeforces:a2', 'codeforces:h'], catalogComplete: false },
  ];
  const matrix = contestMatrix(contests, problems);
  assert.deepEqual(matrix.columns, [{ key: 'A', label: 'A' }, { key: 'H', label: 'H / Ex' }]);
  assert.deepEqual(matrix.rows[0].cells.get('A'), [{ id: 'atcoder:shared', index: 'A' }]);
  assert.deepEqual(matrix.rows[1].cells.get('A').map((problem) => problem.index), ['A1', 'A2']);
  assert.equal(matrix.rows[0].cells.get('H')[0].index, 'Ex');
  assert.equal(matrix.rows[0].cells.has('D'), false);
  assert.equal(matrix.rows.flatMap((row) => [...row.cells.values()].flat()).length, 5);
});
