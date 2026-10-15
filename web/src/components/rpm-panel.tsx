"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Timer, XCircle } from "lucide-react";

import { Tooltip } from "@/components/motion/tooltip";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { fetchAiMetrics, type AiMetrics } from "@/lib/api";
import { cn } from "@/lib/utils";

const REFRESH_INTERVAL = 10_000;
const TREND_MINUTES = 30;

/** 把峰值向上取整到"好读"的刻度：1 / 2 / 5 × 10^n */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function formatTick(value: number) {
  return value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value);
}

type TrendPoint = AiMetrics["trend"][number];

/** 每分钟调用次数柱状图：单序列，柱宽 ≤ 24px、顶部 4px 圆角，悬停/聚焦每根柱子查看数值 */
function TrendBars({ points }: { points: TrendPoint[] }) {
  const peak = Math.max(0, ...points.map((point) => point.count));
  const top = niceMax(peak);
  const ticks = [top, top / 2, 0];
  const labelIndexes = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);

  if (points.length === 0) {
    return <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">暂无趋势数据</div>;
  }

  return (
    <div className="flex gap-3">
      {/* Y 轴刻度 */}
      <div className="flex h-40 w-7 shrink-0 flex-col justify-between text-right text-[11px] leading-none text-muted-foreground tabular-nums">
        {ticks.map((tick) => (
          <span key={tick}>{formatTick(tick)}</span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-40">
          {/* 发丝网格线：放在柱子下面，颜色比卡片面只深一档 */}
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden="true"
              className="absolute inset-x-0 h-px bg-chart-grid"
              style={{ top: `${(1 - tick / top) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end justify-between gap-[2px]">
            {points.map((point) => (
              <Tooltip
                key={point.timestamp}
                side="top"
                content={
                  <span className="flex items-baseline gap-1.5 whitespace-nowrap">
                    <span className="font-semibold text-foreground tabular-nums">{point.count} 次</span>
                    <span className="text-muted-foreground">{point.minute}</span>
                  </span>
                }
              >
                <div
                  tabIndex={0}
                  aria-label={`${point.minute} ${point.count} 次调用`}
                  className="group flex h-full max-w-6 min-w-0 flex-1 items-end justify-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div
                    className="w-full rounded-t-[4px] bg-primary transition-[height,filter] duration-300 group-hover:brightness-125 group-focus-visible:brightness-125"
                    style={{ height: `${top > 0 ? (point.count / top) * 100 : 0}%` }}
                  />
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
        {/* X 轴：只标首、中、尾三个时间点 */}
        <div className="mt-2 flex justify-between gap-[2px] text-[11px] leading-none text-muted-foreground tabular-nums">
          {points.map((point, index) => (
            <span key={point.timestamp} className="flex max-w-6 min-w-0 flex-1 justify-center overflow-visible whitespace-nowrap">
              {labelIndexes.has(index) ? point.minute : ""}
            </span>
          ))}
        </div>
      </div>
      {/* 读屏用的表格视图：每个数值都不依赖悬停也能读到 */}
      <table className="sr-only">
        <caption>最近 {TREND_MINUTES} 分钟每分钟调用次数</caption>
        <tbody>
          {points.map((point) => (
            <tr key={point.timestamp}>
              <th scope="row">{point.minute}</th>
              <td>{point.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RpmPanel() {
  const [metrics, setMetrics] = useState<AiMetrics | null>(null);
  const [error, setError] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const data = await fetchAiMetrics({ trend_minutes: TREND_MINUTES });
        if (!active) return;
        setMetrics(data);
        setError("");
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "加载调用统计失败");
      }
    };

    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const start = () => {
      stop();
      void load();
      timerRef.current = setInterval(() => void load(), REFRESH_INTERVAL);
    };

    // 页面切到后台时停止轮询，避免无谓请求把 RPM 数据窗口空转
    const handleVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    start();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const trend = metrics?.trend ?? [];
  const trendPeak = Math.max(0, ...trend.map((point) => point.count));
  const endpointPeak = Math.max(1, ...(metrics?.by_endpoint.map((item) => item.count) ?? []));

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="RPM"
          icon={<Activity />}
          tone="primary"
          value={metrics ? metrics.rpm : "-"}
          hint={metrics ? `最近 ${metrics.window_seconds} 秒 ${metrics.requests} 次调用` : "加载中"}
          trend={trend.map((point) => point.count)}
        />
        <StatCard
          label="成功"
          icon={<CheckCircle2 />}
          tone="success"
          value={metrics ? metrics.success : "-"}
          hint={metrics ? `累计 ${metrics.total_requests} 次` : undefined}
        />
        <StatCard
          label="失败"
          icon={<XCircle />}
          tone="danger"
          value={metrics ? metrics.failed : "-"}
          hint={metrics?.server_time}
        />
        <StatCard
          label="平均耗时"
          icon={<Timer />}
          value={metrics ? metrics.avg_duration_ms / 1000 : "-"}
          format={(seconds) => `${seconds.toFixed(2)} s`}
          hint={`每 ${REFRESH_INTERVAL / 1000} 秒自动刷新`}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardTitle>调用趋势</CardTitle>
              <CardDescription>最近 {TREND_MINUTES} 分钟每分钟的调用次数，悬停柱子查看具体数值。</CardDescription>
            </div>
            <CardAction className="text-xs text-muted-foreground tabular-nums">峰值 {trendPeak} 次/分</CardAction>
          </CardHeader>
          <CardContent className={cn("pt-5 transition-opacity", !metrics && "opacity-50")}>
            <TrendBars points={trend} />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardTitle>按接口统计</CardTitle>
              <CardDescription>当前统计窗口内各接口的调用量</CardDescription>
            </div>
            <CardAction>
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                {metrics?.by_endpoint.length ?? 0} 个
              </span>
            </CardAction>
          </CardHeader>
          <CardContent className="max-h-64 space-y-4 overflow-y-auto">
            {error ? <div className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
            {!error && metrics && metrics.by_endpoint.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">当前窗口内没有 AI 接口调用</div>
            ) : null}
            {metrics?.by_endpoint.map((item) => (
              <div key={item.endpoint} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-[13px] text-foreground" title={item.endpoint}>
                    {item.endpoint}
                  </span>
                  <span className="shrink-0 text-[13px] font-semibold text-foreground tabular-nums">{item.count} 次</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-primary/12">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(item.count / endpointPeak) * 100}%` }} />
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  失败 {item.failed} · 平均 {(item.avg_duration_ms / 1000).toFixed(2)} s
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
