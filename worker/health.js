import { HttpError } from './http.js';

// 健康快照由服务器上的 health 推送（schema_version 1），字段沿用 fitflare 的接口：
// metrics 是指标卡，daily / weekly 是 { metrics: [...元数据], points: [...] } 序列，sleep 是最近的睡眠记录。
const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;

export function today(now = Date.now()) {
  return new Date(now + OFFSET_MS).toISOString().slice(0, 10);
}

export function shiftDay(day, amount) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

export function validateHealthSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || payload.schema_version !== 1) throw new HttpError(400, 'invalid_snapshot', 'schema_version 必须是 1');
  if (!Array.isArray(payload.metrics)) throw new HttpError(400, 'invalid_snapshot', 'metrics 必须是数组');
  for (const key of ['daily', 'weekly']) {
    const series = payload[key];
    if (series !== undefined && (!series || !Array.isArray(series.points) || !Array.isArray(series.metrics))) {
      throw new HttpError(400, 'invalid_snapshot', `${key} 必须包含 metrics 和 points 数组`);
    }
  }
  if (!payload.daily) throw new HttpError(400, 'invalid_snapshot', '缺少 daily 序列');
  if (payload.daily.points.length > 2000) throw new HttpError(400, 'invalid_snapshot', 'daily 最多 2000 个点');
  if (payload.sleep !== undefined && !Array.isArray(payload.sleep)) throw new HttpError(400, 'invalid_snapshot', 'sleep 必须是数组');
  return payload;
}

function mean(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function round(value, digits = 1) {
  return value === null ? null : Number(value.toFixed(digits));
}

// 公开部分只有两项：截至昨天（UTC+8）的 7 天平均睡眠和平均步数，当天的数据不公开。
export function publicHealth(snapshot, now = Date.now()) {
  const end = shiftDay(today(now), -1);
  const start = shiftDay(end, -6);
  const points = (snapshot?.daily?.points || []).filter((point) => point.date >= start && point.date <= end);
  const sleep = mean(points.map((point) => point.sleep_hours));
  const steps = mean(points.map((point) => point.steps));
  return {
    as_of: end,
    window_days: 7,
    sleep_hours_avg7: round(sleep, 1),
    steps_avg7: steps === null ? null : Math.round(steps),
    days_with_data: points.filter((point) => point.steps != null || point.sleep_hours != null).length,
    generated_at: snapshot?.generated_at ?? null,
  };
}

export function healthMetrics(snapshot) {
  return (snapshot?.metrics || []).map((card) => ({
    key: card.key,
    label: card.label,
    unit: card.unit,
    latest: card.latest ?? null,
    latest_date: card.latest_date ?? null,
    avg7: card.avg7 ?? null,
    avg30: card.avg30 ?? null,
    goal: card.goal ?? null,
    trend: card.trend ?? null,
  }));
}

export function availableMetrics(snapshot, granularity = 'daily') {
  return (snapshot?.[granularity]?.metrics || []).map((metric) => metric.key);
}

// 取一段序列：metrics 为空时取全部；days 按日期截取（周序列按周数）。
export function healthSeries(snapshot, { metrics = [], granularity = 'daily', limit = 90 } = {}) {
  const series = snapshot?.[granularity];
  if (!series) return { granularity, metrics: [], points: [] };
  const wanted = metrics.length ? series.metrics.filter((metric) => metrics.includes(metric.key)) : series.metrics;
  const keys = wanted.map((metric) => metric.key);
  const dimension = granularity === 'daily' ? 'date' : 'period';
  const points = series.points.slice(-limit).map((point) => {
    const row = { [dimension]: point[dimension] ?? point.date ?? point.period };
    for (const key of keys) row[key] = point[key] ?? null;
    return row;
  });
  return { granularity, metrics: wanted, points };
}
