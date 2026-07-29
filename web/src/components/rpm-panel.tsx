"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Activity, CheckCircle2, Timer, XCircle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { fetchAiMetrics, type AiMetrics } from "@/lib/api";
import { easeOut, fadeUpItem, listItem, listStagger } from "@/lib/motion";
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
  const reduceMotion = useReducedMotion();

  return (
    <motion.div className="flex items-center gap-3 px-4 py-3" variants={reduceMotion ? undefined : fadeUpItem}>
      <motion.span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-xl bg-stone-100 text-stone-500 dark:bg-white/8 dark:text-stone-300",
          tone === "success" && "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/12 dark:text-emerald-400",
          tone === "danger" && "bg-rose-50 text-rose-600 dark:bg-rose-500/12 dark:text-rose-400",
        )}
        whileHover={reduceMotion ? undefined : { scale: 1.06, rotate: -3 }}
        transition={easeOut}
      >
        {icon}
      </motion.span>
      <div className="min-w-0">
        <div className="text-[11px] tracking-wide text-stone-400 uppercase">{label}</div>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={value}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="truncate text-lg font-semibold text-stone-900 tabular-nums dark:text-stone-100"
          >
            {value}
          </motion.div>
        </AnimatePresence>
        {hint ? <div className="truncate text-[11px] text-stone-400">{hint}</div> : null}
      </div>
    </motion.div>
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
      <Card className="overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="p-0">
          <motion.div
            className="grid divide-y divide-stone-100 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x"
            initial="hidden"
            animate="show"
            variants={reduceMotion ? undefined : listStagger}
          >
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
          </motion.div>
          <div className="grid gap-4 border-t border-stone-100 px-4 py-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-stone-400">
                <span>最近 {TREND_MINUTES} 分钟调用趋势</span>
                <span>峰值 {trendMax}</span>
              </div>
              <svg viewBox="0 0 320 44" preserveAspectRatio="none" className="h-11 w-full" role="img" aria-label="调用趋势">
                <motion.path
                  d={area || undefined}
                  className="fill-stone-900/8 dark:fill-white/10"
                  initial={false}
                  animate={{ opacity: area ? 1 : 0 }}
                  transition={{ duration: 0.35 }}
                />
                <motion.path
                  key={line}
                  d={line || undefined}
                  fill="none"
                  strokeWidth={1.5}
                  className="stroke-stone-900 dark:stroke-stone-100"
                  initial={reduceMotion || !line ? false : { pathLength: 0, opacity: 0.4 }}
                  animate={line ? { pathLength: 1, opacity: 1 } : { opacity: 0 }}
                  transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                />
              </svg>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-stone-400">按接口统计（当前窗口）</div>
              {error ? <div className="text-xs text-rose-500">{error}</div> : null}
              {!error && metrics && metrics.by_endpoint.length === 0 ? (
                <div className="text-xs text-stone-400">当前窗口内没有 AI 接口调用</div>
              ) : null}
              <motion.div
                className="max-h-28 space-y-1 overflow-y-auto pr-1"
                initial="hidden"
                animate="show"
                variants={reduceMotion ? undefined : listStagger}
                key={metrics?.by_endpoint.map((item) => item.endpoint).join("|") || "empty"}
              >
                {metrics?.by_endpoint.map((item) => (
                  <motion.div
                    key={item.endpoint}
                    variants={reduceMotion ? undefined : listItem}
                    className="flex items-center justify-between gap-3 text-xs text-stone-500"
                  >
                    <span className="truncate font-mono text-stone-600 dark:text-stone-300">{item.endpoint}</span>
                    <span className="shrink-0 tabular-nums">
                      {item.count} 次 · 失败 {item.failed} · {(item.avg_duration_ms / 1000).toFixed(2)} s
                    </span>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
