// 刷题数据的计算，和 oj 仓库原来页面的 model.js 保持同一套规则：
// 首次 AC 按“平台 + 题目”去重，日期按 UTC+8 归档，只统计启用的四个平台。
import { dayKey, shiftDay } from '@xw7/ui/format';

export const ACTIVE_PLATFORMS = ['atcoder', 'codeforces', 'qoj', 'nowcoder'];

export function activeDashboard(data) {
  const problems = data.problems.filter((problem) => ACTIVE_PLATFORMS.includes(problem.platform));
  const ids = new Set(problems.map((problem) => problem.id));
  return {
    ...data,
    sources: Object.fromEntries(Object.entries(data.sources).filter(([platform]) => ACTIVE_PLATFORMS.includes(platform))),
    problems,
    accepted: data.accepted.filter((event) => ACTIVE_PLATFORMS.includes(event.platform) && ids.has(event.problemId)),
    attempted: data.attempted.filter((id) => ids.has(id)),
    undatedSolved: data.undatedSolved.filter((id) => ids.has(id)),
    contests: data.contests.filter((contest) => ACTIVE_PLATFORMS.includes(contest.platform) && contest.hasSubmissions === true),
  };
}

export function epochDay(epoch) {
  return dayKey(epoch * 1000);
}

export function firstAccepted(events) {
  const first = new Map();
  for (const event of events) {
    const previous = first.get(event.problemId);
    if (!previous || event.epoch < previous.epoch || (event.epoch === previous.epoch && event.id < previous.id)) first.set(event.problemId, event);
  }
  return first;
}

export function dailyCounts(events) {
  const counts = {};
  for (const event of events) {
    const day = epochDay(event.epoch);
    counts[day] = (counts[day] || 0) + 1;
  }
  return counts;
}

export function cumulative(counts, start, end) {
  let total = Object.entries(counts).reduce((sum, [day, count]) => (day < start ? sum + count : sum), 0);
  const points = [];
  for (let day = start; day <= end; day = shiftDay(day, 1)) {
    total += counts[day] || 0;
    points.push({ x: day, y: total });
  }
  return points;
}

export function streaks(days, today) {
  const sorted = [...new Set(days)].filter((day) => day <= today).sort();
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const day of sorted) {
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  const active = new Set(sorted);
  let cursor = active.has(today) ? today : shiftDay(today, -1);
  let current = 0;
  while (active.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }
  return { current, longest };
}

// 比赛矩阵：按 A、B、C 对齐题号，CF 的 C1/C2 合并到 C，AtCoder 的 Ex 对齐到 H。
export function contestMatrix(contests, problems) {
  const keys = new Set();
  let hasEx = false;
  const rows = contests.map((contest) => {
    const cells = new Map();
    for (const id of contest.problems) {
      const problem = problems.get(id);
      if (!problem) continue;
      const index = contest.problemIndices?.[id] ?? problem.index;
      const key = index === 'Ex' ? 'H' : index.match(/^([A-Z])[0-9]*$/)?.[1] || index;
      hasEx ||= index === 'Ex';
      keys.add(key);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ id, index });
    }
    return { contest, cells };
  });
  const columns = [...keys]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((key) => ({ key, label: key === 'H' && hasEx ? 'H / Ex' : key }));
  return { columns, rows };
}

export function completion(contest, first, attempted) {
  const solved = contest.problems.filter((id) => first.has(id)).length;
  const started = contest.hasSubmissions ?? contest.problems.some((id) => attempted.has(id));
  const total = contest.problems.length;
  return { solved, total, started, complete: Boolean(contest.catalogComplete && total > 0 && solved === total) };
}

export function matchesStatus(progress, status) {
  if (status === 'completed') return progress.complete;
  if (status === 'unfinished') return progress.started && !progress.complete;
  return true;
}
