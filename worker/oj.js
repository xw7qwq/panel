// 刷题汇总（oj 仓库生成的 summary.json）的公开裁剪：最近一年的每日题数和最近 5 次通过。
export function publicOj(summary) {
  if (!summary) return null;
  const since = summary.today ? new Date(Date.parse(`${summary.today}T00:00:00Z`) - 370 * 86_400_000).toISOString().slice(0, 10) : '';
  return {
    generated_at: summary.generated_at ?? null,
    today: summary.today ?? null,
    solved: summary.solved ?? null,
    counts: summary.counts ?? null,
    streak: summary.streak ?? null,
    platforms: summary.platforms ?? null,
    daily: Object.fromEntries(Object.entries(summary.daily || {}).filter(([day]) => day >= since)),
    recent: (summary.recent || []).slice(0, 5),
  };
}
