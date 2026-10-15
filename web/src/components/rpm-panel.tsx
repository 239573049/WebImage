"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Activity, CheckCircle2, Timer, XCircle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { fetchAiMetrics, type AiMetrics } from "@/lib/api";
import { easeOut } from "@/lib/motion";
import { cn } from "@/lib/utils";

const REFRESH_INTERVAL = 10_000;
const TREND_MINUTES = 30;

function buildTrendPath(counts: number[], width: number, height: number) {
  if (counts.length === 0) return { line: "", area: "" };
  const max = Math.max(...counts, 1);
  const step = counts.length > 1 ? width / (counts.length - 1) : width;
  const points = counts.map((count, index) => {
    const x = index * step;
    const y = height - (count / max) * (height - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return {
    line: `M${points.join("L")}`,
    area: `M0,${height}L${points.join("L")}L${(step * (counts.length - 1)).toFixed(2)},${height}Z`,
  };
}

function MetricCell({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "success" | "danger";
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground",
          tone === "success" && "bg-success/15 text-success",
          tone === "danger" && "bg-destructive/15 text-destructive",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
        {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
      </div>
    </div>
  );
}

export function RpmPanel() {
  const [metrics, setMetrics] = useState<AiMetrics | null>(null);
  const [error, setError] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reduceMotion = useReducedMotion();

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

  const trendCounts = metrics?.trend.map((point) => point.count) ?? [];
  const trendMax = Math.max(...trendCounts, 0);
  const { line, area } = buildTrendPath(trendCounts, 320, 44);

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={easeOut}
    >
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
            <MetricCell
              icon={<Activity className="size-4" />}
              label="RPM"
              value={metrics ? String(metrics.rpm) : "-"}
              hint={metrics ? `最近 ${metrics.window_seconds} 秒 ${metrics.requests} 次调用` : "加载中"}
            />
            <MetricCell
              icon={<CheckCircle2 className="size-4" />}
              label="成功"
              value={metrics ? String(metrics.success) : "-"}
              hint={metrics ? `累计 ${metrics.total_requests} 次` : undefined}
              tone="success"
            />
            <MetricCell
              icon={<XCircle className="size-4" />}
              label="失败"
              value={metrics ? String(metrics.failed) : "-"}
              hint={metrics?.server_time}
              tone="danger"
            />
            <MetricCell
              icon={<Timer className="size-4" />}
              label="平均耗时"
              value={metrics ? `${(metrics.avg_duration_ms / 1000).toFixed(2)} s` : "-"}
              hint={`每 ${REFRESH_INTERVAL / 1000} 秒自动刷新`}
            />
          </div>
          <div className="grid gap-4 border-t border-border px-4 py-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>最近 {TREND_MINUTES} 分钟调用趋势</span>
                <span className="tabular-nums">峰值 {trendMax}</span>
              </div>
              <svg viewBox="0 0 320 44" preserveAspectRatio="none" className="h-11 w-full" role="img" aria-label="调用趋势">
                <path d={area || undefined} className="fill-primary/10" />
                <path
                  d={line || undefined}
                  fill="none"
                  strokeWidth={1.5}
                  className="stroke-primary"
                />
              </svg>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">按接口统计（当前窗口）</div>
              {error ? <div className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
              {!error && metrics && metrics.by_endpoint.length === 0 ? (
                <div className="text-xs text-muted-foreground">当前窗口内没有 AI 接口调用</div>
              ) : null}
              <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                {metrics?.by_endpoint.map((item) => (
                  <div key={item.endpoint} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="truncate font-mono text-foreground/80">{item.endpoint}</span>
                    <span className="shrink-0 tabular-nums">
                      {item.count} 次 · 失败 {item.failed} · {(item.avg_duration_ms / 1000).toFixed(2)} s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
