// 健康页的小工具：周序列的横轴、指标颜色、时间窗口。
import { shiftDay } from '@xw7/ui/format';

// "2026-W03" → 那一周的周一（ISO 周）。
export function isoWeekMonday(period) {
  const match = /^(\d{4})-W(\d{2})$/.exec(period ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const offset = (new Date(jan4).getUTCDay() + 6) % 7;
  return new Date(jan4 + ((week - 1) * 7 - offset) * 86_400_000).toISOString().slice(0, 10);
}

// health 沿用的色调名 → 图表色。
const TONES = { red: 'var(--series-1)', blue: 'var(--series-2)', green: 'var(--series-3)', teal: 'var(--series-3)', amber: 'var(--series-4)' };

export function toneColor(tone, fallback = 'var(--series-1)') {
  return TONES[tone] ?? fallback;
}

// 取一个指标的序列：按天用 date，按周用周一。只保留窗口内的点。
export function metricPoints(series, key, { granularity = 'daily', since = null } = {}) {
  if (!series?.points) return [];
  const points = [];
  for (const point of series.points) {
    const x = granularity === 'daily' ? point.date : isoWeekMonday(point.period);
    if (!x || (since && x < since)) continue;
    const value = point[key];
    points.push({ x, y: typeof value === 'number' && Number.isFinite(value) ? value : null });
  }
  return points;
}

export function windowStart(today, days) {
  return shiftDay(today, -(days - 1));
}
