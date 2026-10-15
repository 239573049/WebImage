"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  HeartPulse,
  Link2,
  LoaderCircle,
  LogIn,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { toast } from "sonner";

import { AnimatedNumber } from "@/components/motion/animated-number";
import { PageEnter } from "@/components/page-enter";
import { PageLoader } from "@/components/page-loader";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteAccounts,
  fetchAccounts,
  fetchModels,
  fetchProxyPool,
  fetchRefreshProgress,
  fetchReLoginProgress,
  reLoginAccounts,
  refreshAccounts,
  resetAccountsHealth,
  testProxy,
  testProxyPoolEntry,
  updateAccount,
  type Account,
  type AccountRefreshResponse,
  type AccountStatus,
  type Model,
  type ProxyPoolItem,
  type ProxyPoolPayload,
  type RefreshProgressResponse,
} from "@/lib/api";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import {
  getProxyHealthMeta,
  isProxyUnavailable,
  maskProxyUrl,
  pickProxyPoolPayload,
  proxyPoolLabel,
} from "@/lib/proxy-pool";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

import { AccountImportDialog } from "./components/account-import-dialog";

const accountStatusOptions: { label: string; value: AccountStatus | "all" }[] = [
  { label: "全部状态", value: "all" },
  { label: "正常", value: "正常" },
  { label: "限流", value: "限流" },
  { label: "异常", value: "异常" },
  { label: "禁用", value: "禁用" },
];

/** 状态标签页：计数直接显示在标签上，代替原来的六张指标卡 */
const statusTabs: { label: string; value: AccountStatus | "all" }[] = [
  { label: "全部", value: "all" },
  { label: "正常", value: "正常" },
  { label: "限流", value: "限流" },
  { label: "异常", value: "异常" },
  { label: "禁用", value: "禁用" },
];

const statusDotClass: Record<AccountStatus, string> = {
  正常: "bg-success",
  限流: "bg-warning",
  异常: "bg-destructive",
  禁用: "bg-muted-foreground",
};

const statusTextClass: Record<AccountStatus, string> = {
  正常: "text-success",
  限流: "text-warning",
  异常: "text-destructive",
  禁用: "text-muted-foreground",
};

const healthStateLabel: Record<string, string> = {
  healthy: "健康",
  degraded: "降级",
  probation: "观察",
  open: "熔断",
  half_open: "半开",
};

// 底部批量操作条是反色底（浅色主题深底、深色主题弹层底），按钮颜色要跟着反过来
const bulkButtonClass =
  "h-7 rounded-lg px-2.5 text-background hover:bg-background/10 hover:text-background dark:text-popover-foreground dark:hover:bg-white/10 dark:hover:text-popover-foreground";

type PoolSummary = {
  total: number;
  active: number;
  limited: number;
  abnormal: number;
  disabled: number;
  /** 正常账号的剩余额度合计 */
  quota: number;
};

function formatCompact(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

function formatQuota(account: Account) {
  return String(Math.max(0, account.quota));
}

/** 表格里只放相对时间（1d 4h），绝对时间放进 title */
function formatRestoreAt(value?: string | null) {
  if (!value) {
    return { absolute: "—", relative: "" };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { absolute: value, relative: "" };
  }

  const diffMs = Math.max(0, date.getTime() - Date.now());
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const relative = diffMs > 0 ? `${days}d ${hours}h` : "已到期";

  const pad = (num: number) => String(num).padStart(2, "0");
  const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  return { absolute, relative };
}

function formatCreatedAt(raw?: string | null) {
  if (!raw) return "—";
  const date = new Date(`${raw}Z`);
  if (Number.isNaN(date.getTime())) return String(raw).slice(0, 10);
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function maskToken(token?: string) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 16)}...${token.slice(-8)}`;
}

function downloadTokens(accounts: Account[]) {
  const content = `${accounts.map((account) => account.access_token).join("\n")}\n`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `accounts-${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function displayAccountType(account: Account) {
  return account.type || "Free";
}

function displayAccountSource(account: Account) {
  const source = String(account.source_type || "").trim().toLowerCase();
  if (!source) {
    return "web";
  }
  if (source === "web") {
    return "web";
  }
  return source;
}

function matchesQuery(account: Account, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery.length === 0 || (account.email ?? "").toLowerCase().includes(normalizedQuery);
}

function matchesType(account: Account, typeFilter: string) {
  return typeFilter === "all" || displayAccountType(account) === typeFilter;
}

/** 健康分的展示信息；完整明细（成功率、延迟、最近错误等）放在 title 里悬停查看 */
function getHealthInfo(account: Account) {
  const score = account.health_score ?? 100;
  const state = account.health_state ?? "healthy";
  const label = healthStateLabel[state] ?? state;
  const colorClass =
    state === "open"
      ? "text-destructive"
      : state === "half_open" || state === "probation" || state === "degraded"
        ? "text-warning"
        : "text-success";
  const cooldownUntil = account.health_cooldown_until;
  const cooldownLeft =
    typeof cooldownUntil === "number" && cooldownUntil * 1000 > Date.now()
      ? Math.ceil(cooldownUntil - Date.now() / 1000)
      : 0;
  const tooltip = [
    `健康分 ${score}`,
    `状态 ${label}`,
    account.health_success_rate != null ? `成功率 ${(account.health_success_rate * 100).toFixed(1)}%` : null,
    account.health_latency_ms ? `延迟 ${(account.health_latency_ms / 1000).toFixed(1)}s` : null,
    account.health_consecutive_failures ? `连续失败 ${account.health_consecutive_failures}` : null,
    cooldownLeft > 0 ? `冷却剩余 ${Math.floor(cooldownLeft / 60)}分${cooldownLeft % 60}秒` : null,
    account.health_last_error ? `最近错误: ${account.health_last_error}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return { score, label, colorClass, cooldownLeft, tooltip };
}

/** 页头标题旁的小指标 */
function HeaderStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs whitespace-nowrap text-muted-foreground">
      {label}
      <span className="font-semibold text-foreground tabular-nums">{children}</span>
    </span>
  );
}

/** 编辑对话框里的池代理选项：名称 + 健康状态 */
function ProxyPoolOption({ item }: { item: ProxyPoolItem }) {
  const health = getProxyHealthMeta(item.health?.state);
  return (
    <SelectItem value={item.id}>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", health.dotClass)} />
        <span className="truncate text-foreground">{proxyPoolLabel(item)}</span>
        <span className={cn("shrink-0 text-xs", health.textClass)}>{health.label}</span>
        {!item.enabled ? <span className="shrink-0 text-xs text-muted-foreground">已禁用</span> : null}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.bound_count} 个账号</span>
      </span>
    </SelectItem>
  );
}

/** 列表里的代理列：池开启时显示绑定的代理名，代理禁用或异常时标「借用中」；池关闭时显示脱敏后的手填代理 */
function AccountProxyCell({
  account,
  poolEnabled,
  poolItemsById,
}: {
  account: Account;
  poolEnabled: boolean;
  poolItemsById: Map<string, ProxyPoolItem>;
}) {
  if (!poolEnabled) {
    const masked = maskProxyUrl(account.proxy);
    return masked ? (
      <span className="block max-w-[160px] truncate font-mono text-foreground/80" title={masked}>
        {masked}
      </span>
    ) : (
      <span className="text-muted-foreground">全局</span>
    );
  }

  const proxyId = account.proxy_id ?? "";
  if (!proxyId) {
    return <span className="text-muted-foreground" title="首次请求时自动分配">未绑定</span>;
  }
  const item = poolItemsById.get(proxyId);
  if (!item) {
    return <span className="text-muted-foreground" title={`代理 ${proxyId} 不在池中`}>已失效</span>;
  }
  const health = getProxyHealthMeta(item.health?.state);
  const borrowing = isProxyUnavailable(item);
  return (
    <span
      className="inline-flex max-w-[180px] items-center gap-1.5"
      title={[
        proxyPoolLabel(item),
        item.masked_url,
        `健康：${health.label}`,
        !item.enabled ? "代理已禁用" : null,
        borrowing ? "绑定的代理不可用，正在临时借用其他代理" : null,
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", health.dotClass)} />
      <span className="truncate text-foreground/80">{proxyPoolLabel(item)}</span>
      {borrowing ? (
        <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-[10.5px]">
          借用中
        </Badge>
      ) : null}
    </span>
  );
}

function AccountsPageContent() {
  const didLoadRef = useRef(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<AccountStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editStatus, setEditStatus] = useState<AccountStatus>("正常");
  const [editProxy, setEditProxy] = useState("");
  const [editProxyId, setEditProxyId] = useState("");
  // 代理池开启时，账号编辑改为从池里选择代理；拉取失败（例如后端尚不支持）按未开启处理
  const [proxyPool, setProxyPool] = useState<ProxyPoolPayload | null>(null);
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshingTokens, setRefreshingTokens] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRelogining, setIsRelogining] = useState(false);
  const [isResettingHealth, setIsResettingHealth] = useState(false);
  const [progress, setProgress] = useState<{
    visible: boolean;
    current: number;
    total: number;
    message: string;
    email: string;
  }>({
    visible: false,
    current: 0,
    total: 0,
    message: "",
    email: "",
  });
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 批量刷新 / 恢复过程中的实时汇总，完成后清空，回到按 accounts 计算的 summary
  const [refreshSummary, setRefreshSummary] = useState<PoolSummary | null>(null);

  const loadAccounts = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const data = await fetchAccounts();
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载账户失败";
      toast.error(message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  const loadProxyPool = async () => {
    try {
      const data = await fetchProxyPool();
      setProxyPool(pickProxyPoolPayload(data));
    } catch {
      /* 静默失败：保持旧的手填代理输入 */
    }
  };

  const loadModels = async () => {
    setIsLoadingModels(true);
    try {
      const data = await fetchModels();
      setAvailableModels(Array.isArray(data.data) ? data.data : []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载模型列表失败";
      toast.error(message);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadAccounts();
    void loadModels();
    void loadProxyPool();

    // 清理进度条定时器
    return () => {
      if (progressRef.current) clearInterval(progressRef.current);
    };
  }, []);

  const poolEnabled = Boolean(proxyPool?.settings.enabled);
  const poolItems = useMemo(() => proxyPool?.items ?? [], [proxyPool]);
  const poolItemsById = useMemo(() => new Map(poolItems.map((item) => [item.id, item])), [poolItems]);

  const filteredAccounts = useMemo(() => {
    return accounts.filter(
      (account) =>
        matchesQuery(account, query) &&
        matchesType(account, typeFilter) &&
        (statusFilter === "all" || account.status === statusFilter),
    );
  }, [accounts, query, statusFilter, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredAccounts.length / Number(pageSize)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const currentRows = filteredAccounts.slice(startIndex, startIndex + Number(pageSize));
  const allCurrentSelected =
    currentRows.length > 0 && currentRows.every((row) => selectedIds.includes(row.access_token));

  const summary = useMemo<PoolSummary>(() => {
    const total = accounts.length;
    const active = accounts.filter((item) => item.status === "正常").length;
    const limited = accounts.filter((item) => item.status === "限流").length;
    const abnormal = accounts.filter((item) => item.status === "异常").length;
    const disabled = accounts.filter((item) => item.status === "禁用").length;
    const quota = accounts
      .filter((item) => item.status === "正常")
      .reduce((sum, item) => sum + Math.max(0, item.quota), 0);

    return { total, active, limited, abnormal, disabled, quota };
  }, [accounts]);

  const accountTypeOptions = useMemo(
    () => [
      { label: "全部类型", value: "all" },
      ...Array.from(new Set(accounts.map(displayAccountType))).map((type) => ({ label: type, value: type })),
    ],
    [accounts],
  );

  const selectedTokens = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return accounts.filter((item) => selectedSet.has(item.access_token)).map((item) => item.access_token);
  }, [accounts, selectedIds]);

  const abnormalTokens = useMemo(() => {
    return accounts.filter((item) => item.status === "异常").map((item) => item.access_token);
  }, [accounts]);

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);

    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);

    return items;
  }, [pageCount, safePage]);

  const handleDeleteTokens = async (tokens: string[]) => {
    if (tokens.length === 0) {
      toast.error("请先选择要删除的账户");
      return;
    }

    setIsDeleting(true);
    try {
      const data = await deleteAccounts(tokens);
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
      toast.success(`删除 ${data.removed ?? 0} 个账户`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除账户失败";
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleResetHealth = async (tokens: string[]) => {
    if (tokens.length === 0) {
      toast.error("请先选择要重置健康状态的账户");
      return;
    }
    setIsResettingHealth(true);
    try {
      const data = await resetAccountsHealth(tokens);
      if (Array.isArray(data.items)) {
        setAccounts(data.items);
      }
      toast.success(`已重置 ${tokens.length} 个账号的健康状态`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "重置健康状态失败";
      toast.error(message);
    } finally {
      setIsResettingHealth(false);
    }
  };

  const handleRefreshAccounts = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("没有需要刷新的账户");
      return;
    }

    if (accessTokens.length === 1) {
      setRefreshingTokens((prev) => new Set([...prev, accessTokens[0]]));
      try {
        const { progress_id } = await refreshAccounts(accessTokens);
        // 单账号：轮询等待完成
        await pollRefreshProgress(progress_id, (progress) => {
          if (progress.done && progress.result) {
            setAccounts(progress.result.items);
            setSelectedIds((prev) => prev.filter((id) => progress.result!.items.some((item) => item.access_token === id)));
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "刷新账户失败";
        toast.error(message);
      } finally {
        setRefreshingTokens((prev) => {
          const next = new Set(prev);
          next.delete(accessTokens[0]);
          return next;
        });
      }
      return;
    }

    setIsRefreshing(true);

    // 计算非选中账号的基数（统计卡片联动用）
    const selectedTokenSet = new Set(accessTokens);
    const baseAccountsList = accounts.filter((a) => !selectedTokenSet.has(a.access_token));
    const baseActive = baseAccountsList.filter((a) => a.status === "正常").length;
    const baseLimited = baseAccountsList.filter((a) => a.status === "限流").length;
    const baseAbnormal = baseAccountsList.filter((a) => a.status === "异常").length;
    const baseDisabled = baseAccountsList.filter((a) => a.status === "禁用").length;
    const baseNormalAccounts = baseAccountsList.filter((a) => a.status === "正常");
    const baseQuotaNum = baseNormalAccounts.reduce((s, a) => s + Math.max(0, a.quota), 0);

    // 显示进度条（只显示当前任务，不含分类统计）
    const total = accessTokens.length;
    setProgress({
      visible: true,
      current: 0,
      total,
      message: "正在刷新账号信息...",
      email: "",
    });

    try {
      const { progress_id } = await refreshAccounts(accessTokens);

      // 轮询进度到完成
      const data = await new Promise<AccountRefreshResponse>((resolve, reject) => {
        const pollTimer = setInterval(async () => {
          try {
            const p = await fetchRefreshProgress(progress_id);
            if (p.done) {
              clearInterval(pollTimer);
              if (p.error) {
                reject(new Error(p.error));
                return;
              }
              if (!p.result) {
                reject(new Error("刷新结果为空"));
                return;
              }
              // 更新最终进度显示
              setProgress((prev) => ({
                ...prev,
                current: prev.total,
                message: "刷新完成",
              }));
              // 清除联动统计
              setRefreshSummary(null);
              resolve(p.result);
            } else {
              // 实时更新进度
              setProgress((prev) => ({
                ...prev,
                current: p.processed,
              }));
              // 实时更新统计卡片：基数 + 已刷新的累加结果
              const runningActive = baseActive + ((p.status_counts?.["正常"]) ?? 0);
              const runningLimited = baseLimited + ((p.status_counts?.["限流"]) ?? 0);
              const runningAbnormal = baseAbnormal + ((p.status_counts?.["异常"]) ?? 0);
              const runningDisabled = baseDisabled + ((p.status_counts?.["禁用"]) ?? 0);
              setRefreshSummary({
                total: accounts.length,
                active: runningActive,
                limited: runningLimited,
                abnormal: runningAbnormal,
                disabled: runningDisabled,
                quota: baseQuotaNum + (p.total_quota ?? 0),
              });
            }
          } catch (err) {
            clearInterval(pollTimer);
            reject(err);
          }
        }, 300);
      });

      // 刷新完成，更新数据
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));

      const relogined = data.relogined ?? 0;

      // 显示重新登录进度
      if (relogined > 0) {
        setProgress({
          visible: true,
          current: 0,
          total: relogined,
          message: `正在尝试对 ${relogined} 个账号进行移除异常状态`,
          email: "",
        });
        // 模拟重新登录进度
        let reCount = 0;
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            reCount += 1;
            if (reCount >= relogined) {
              clearInterval(timer);
              setProgress({
                visible: true,
                current: relogined,
                total: relogined,
                message: "移除异常状态完成",
                email: "",
              });
              setTimeout(() => setProgress({ visible: false, current: 0, total: 0, message: "", email: "" }), 800);
              resolve();
            } else {
              setProgress((prev) => ({ ...prev, current: reCount }));
            }
          }, 150);
          setTimeout(resolve, 2000);
        });
      } else {
        setProgress({
          visible: true,
          current: total,
          total,
          message: "刷新完成",
          email: "",
        });
        setTimeout(() => setProgress({ visible: false, current: 0, total: 0, message: "", email: "" }), 800);
      }

      if ((data.errors ?? []).length > 0) {
        const firstError = data.errors?.[0]?.error;
        toast.error(
          `刷新成功 ${data.refreshed} 个，失败 ${(data.errors ?? []).length} 个${firstError ? `，首个错误：${firstError}` : ""}`,
        );
      } else {
        toast.success(`刷新成功 ${data.refreshed} 个账户${relogined > 0 ? `，已触发 ${relogined} 个账号重新登录` : ""}`);
      }
    } catch (error) {
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      setRefreshSummary(null);
      const message = error instanceof Error ? error.message : "刷新账户失败";
      toast.error(message);
    } finally {
      setIsRefreshing(false);
    }
  };

  const pollRefreshProgress = async (
    progressId: string,
    onUpdate: (p: RefreshProgressResponse) => void,
  ): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const p = await fetchRefreshProgress(progressId);
          if (p.done) {
            clearInterval(timer);
            if (p.error) {
              reject(new Error(p.error));
            } else {
              onUpdate(p);
              resolve();
            }
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
        }
      }, 500);
    });
  };

  const handleReLogin = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("请先选择要恢复的账户");
      return;
    }

    // 只处理异常账号，过滤非异常账号
    const abnormalTokens = accessTokens.filter((token) => {
      const account = accounts.find((a) => a.access_token === token);
      return account?.status === "异常";
    });

    if (abnormalTokens.length === 0) {
      toast.error("选中账号中没有异常账号");
      return;
    }

    if (abnormalTokens.length < accessTokens.length) {
      toast.info(`已过滤 ${accessTokens.length - abnormalTokens.length} 个非异常账号`);
    }

    setIsRelogining(true);

    // 计算非选中账号的基数（统计卡片联动用）
    const selectedTokenSet = new Set(abnormalTokens);
    const baseAccountsList = accounts.filter((a) => !selectedTokenSet.has(a.access_token));
    const baseActive = baseAccountsList.filter((a) => a.status === "正常").length;
    const baseLimited = baseAccountsList.filter((a) => a.status === "限流").length;
    const baseAbnormal = baseAccountsList.filter((a) => a.status === "异常").length;
    const baseDisabled = baseAccountsList.filter((a) => a.status === "禁用").length;

    // 显示进度条（真实进度）
    const total = abnormalTokens.length;
    setProgress({ visible: true, current: 0, total, message: "正在尝试恢复异常账号...", email: "" });

    try {
      const { progress_id } = await reLoginAccounts(abnormalTokens);

      // 轮询进度到完成
      await new Promise<void>((resolve, reject) => {
        const pollTimer = setInterval(async () => {
          try {
            const p = await fetchReLoginProgress(progress_id);
            if (p.done) {
              clearInterval(pollTimer);
              if (p.error) {
                reject(new Error(p.error));
                return;
              }
              setProgress((prev) => ({ ...prev, current: prev.total, message: "恢复流程已完成" }));
              setRefreshSummary(null);
              resolve();
            } else {
              // 实时更新进度
              const results = p.results ?? [];
              // 找到最新一条有错误的结果
              const lastErrorResult = [...results].reverse().find((r) => r.error);
              const emailHint = lastErrorResult
                ? `失败: ${lastErrorResult.token} ${lastErrorResult.error ?? ""}`
                : `已处理 ${p.processed}/${p.total}`;
              setProgress((prev) => ({
                ...prev,
                current: p.processed,
                email: emailHint,
                message: "正在尝试恢复异常账号...",
              }));

              // 实时更新统计卡片：基数 + 已处理的恢复结果
              let runningActive = baseActive;
              let runningAbnormal = baseAbnormal;
              let runningDisabled = baseDisabled;
              for (const r of results) {
                if (r.status === "成功") {
                  runningActive += 1;
                  runningAbnormal -= 1;
                } else if (r.status === "禁用") {
                  runningDisabled += 1;
                  runningAbnormal -= 1;
                }
                // "异常"或"跳过"：保持异常状态不变
              }
              setRefreshSummary({
                total: accounts.length,
                active: runningActive,
                limited: baseLimited,
                abnormal: runningAbnormal,
                disabled: runningDisabled,
                quota: summary.quota,
              });
            }
          } catch (err) {
            clearInterval(pollTimer);
            reject(err);
          }
        }, 300);
      });

      // 等待后台线程完成，再拉取最新数据
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      try {
        const freshData = await fetchAccounts();
        setAccounts(freshData.items);
        setSelectedIds((prev) => prev.filter((id) => freshData.items.some((item) => item.access_token === id)));
      } catch { /* 静默失败 */ }

      setProgress({
        visible: true,
        current: total,
        total,
        message: "恢复完成",
        email: "",
      });
      setTimeout(() => setProgress({ visible: false, current: 0, total: 0, message: "", email: "" }), 800);

      toast.success(`恢复流程已全部完成`);
    } catch (error) {
      setProgress({ visible: false, current: 0, total: 0, message: "", email: "" });
      setRefreshSummary(null);
      const message = error instanceof Error ? error.message : "重新登录失败";
      toast.error(message);
    } finally {
      setIsRelogining(false);
    }
  };

  const openEditDialog = (account: Account) => {
    setEditingAccount(account);
    setEditStatus(account.status);
    setEditProxy(account.proxy ?? "");
    setEditProxyId(account.proxy_id ?? "");
  };

  const handleTestPoolProxy = async () => {
    const item = poolItemsById.get(editProxyId);
    if (!item) {
      toast.error("请先选择代理");
      return;
    }
    setIsTestingProxy(true);
    try {
      const data = await testProxyPoolEntry(item.id);
      setProxyPool(pickProxyPoolPayload(data));
      if (data.result?.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms${data.result.exit_ip ? `，出口 ${data.result.exit_ip}` : ""}）`);
      } else {
        toast.error(`代理不可用：${data.result?.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleTestAccountProxy = async () => {
    if (poolEnabled) {
      await handleTestPoolProxy();
      return;
    }
    const candidate = editProxy.trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    try {
      const data = await testProxy(candidate);
      data.result.ok
        ? toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`)
        : toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleUpdateAccount = async () => {
    if (!editingAccount) {
      return;
    }

    setIsUpdating(true);
    try {
      const updates: Parameters<typeof updateAccount>[1] = { status: editStatus };
      if (poolEnabled) {
        // 池开启时只提交改过的绑定，不再发送旧的 proxy 字段
        if (editProxyId && editProxyId !== (editingAccount.proxy_id ?? "")) {
          updates.proxy_id = editProxyId;
        }
      } else if (editProxy.trim() !== (editingAccount.proxy ?? "").trim()) {
        updates.proxy = editProxy.trim();
      }
      const data = await updateAccount(editingAccount.access_token, updates);
      setAccounts(data.items);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.access_token === id)));
      setEditingAccount(null);
      toast.success("账号信息已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新账号失败";
      toast.error(message);
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentRows.map((item) => item.access_token)])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !currentRows.some((row) => row.access_token === id)));
  };

  const liveSummary = refreshSummary ?? summary;

  // 标签计数跟随搜索和类型筛选；没有筛选时用汇总，批量刷新过程中会实时跳动
  const statusCounts = useMemo<Record<AccountStatus | "all", number>>(() => {
    if (!query.trim() && typeFilter === "all") {
      return {
        all: liveSummary.total,
        正常: liveSummary.active,
        限流: liveSummary.limited,
        异常: liveSummary.abnormal,
        禁用: liveSummary.disabled,
      };
    }
    const base = accounts.filter((account) => matchesQuery(account, query) && matchesType(account, typeFilter));
    const countOf = (status: AccountStatus) => base.filter((account) => account.status === status).length;
    return { all: base.length, 正常: countOf("正常"), 限流: countOf("限流"), 异常: countOf("异常"), 禁用: countOf("禁用") };
  }, [accounts, liveSummary, query, typeFilter]);

  const poolActivity = useMemo(() => {
    const inflight = accounts.reduce((sum, account) => sum + (account.image_inflight ?? 0), 0);
    const success = accounts.reduce((sum, account) => sum + account.success, 0);
    const fail = accounts.reduce((sum, account) => sum + account.fail, 0);
    const attempts = success + fail;
    return {
      inflight,
      successRate: attempts > 0 ? `${((success / attempts) * 100).toFixed(1)}%` : "—",
    };
  }, [accounts]);

  const someCurrentSelected =
    !allCurrentSelected && currentRows.some((row) => selectedIds.includes(row.access_token));
  const isBusy = isLoading || isRefreshing || isDeleting;

  return (
    <PageEnter className="space-y-3">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2">
          <h1 className="text-xl leading-tight font-semibold tracking-tight text-foreground">号池管理</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <HeaderStat label="剩余额度">
              <AnimatedNumber value={liveSummary.quota} format={formatCompact} duration={0.9} />
            </HeaderStat>
            <HeaderStat label="在途">{poolActivity.inflight}</HeaderStat>
            <HeaderStat label="成功率">{poolActivity.successRate}</HeaderStat>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="group/models">
                <Box className="size-4 text-muted-foreground" />
                可用模型
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-secondary px-1.5 text-[11px] font-semibold tabular-nums">
                  {availableModels.length}
                </span>
                <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]/models:rotate-180" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(460px,calc(100vw-32px))] p-2.5">
              <div className="mb-2 flex items-center justify-between px-0.5 text-xs">
                <span className="font-semibold text-foreground">系统可用模型</span>
                <span className="text-muted-foreground">点击复制模型名</span>
              </div>
              {availableModels.length > 0 ? (
                <div className="flex max-h-72 flex-wrap gap-1 overflow-y-auto">
                  {availableModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className="inline-flex h-6 cursor-pointer items-center rounded-md border border-border px-2 font-mono text-[11.5px] text-foreground/80 transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        void navigator.clipboard.writeText(model.id);
                        toast.success("模型名已复制");
                      }}
                      title={`点击复制 ${model.id}`}
                    >
                      {model.id}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-0.5 py-2 text-xs text-muted-foreground">
                  {isLoadingModels ? "正在加载模型列表..." : "当前暂无可用模型"}
                </p>
              )}
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="重新加载列表"
            title="重新加载列表"
            onClick={() => {
              void loadAccounts();
              void loadProxyPool();
            }}
            disabled={isBusy}
          >
            <RefreshCw className={cn("size-4", isLoading ? "animate-spin" : "")} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="刷新所有账号信息和额度"
            onClick={() => void handleRefreshAccounts(accounts.map((item) => item.access_token))}
            disabled={isBusy || accounts.length === 0}
          >
            <RefreshCw className={cn("size-4", isRefreshing ? "animate-spin" : "")} />
            全部刷新
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="导出全部 Token"
            title="导出全部 Token"
            onClick={() => downloadTokens(accounts)}
            disabled={accounts.length === 0}
          >
            <Download className="size-4" />
          </Button>
          <AccountImportDialog
            size="sm"
            disabled={isBusy}
            onImported={(items) => {
              setAccounts(items);
              setSelectedIds([]);
              setPage(1);
            }}
          />
        </div>
      </header>

      <Dialog open={Boolean(editingAccount)} onOpenChange={(open) => (!open ? setEditingAccount(null) : null)}>
        <DialogContent showCloseButton={false} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑账户</DialogTitle>
            <DialogDescription>
              {poolEnabled ? "手动修改账号状态和绑定的代理池代理。" : "手动修改账号状态和专属代理。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground/80">状态</label>
              <Select value={editStatus} onValueChange={(value) => setEditStatus(value as AccountStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accountStatusOptions
                    .filter((option) => option.value !== "all")
                    .map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {poolEnabled ? (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">绑定代理</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={editProxyId} onValueChange={setEditProxyId} disabled={poolItems.length === 0}>
                    <SelectTrigger aria-label="绑定代理" className="min-w-0 flex-1">
                      <SelectValue placeholder={poolItems.length === 0 ? "代理池里还没有代理" : "未绑定（首次请求时自动分配）"} />
                    </SelectTrigger>
                    <SelectContent>
                      {editProxyId && !poolItemsById.has(editProxyId) ? (
                        <SelectItem value={editProxyId} disabled>
                          已失效的代理
                        </SelectItem>
                      ) : null}
                      {poolItems.map((item) => (
                        <ProxyPoolOption key={item.id} item={item} />
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    className="sm:w-24"
                    onClick={() => void handleTestAccountProxy()}
                    disabled={isTestingProxy || !poolItemsById.has(editProxyId)}
                  >
                    {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                    测试
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  绑定会一直保留，只有删除代理才会自动改绑；绑定的代理禁用或异常时会临时借用其他代理。
                  <Link href="/proxies" className="ml-1 text-primary underline-offset-4 hover:underline">
                    管理代理池
                  </Link>
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">账号代理</label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={editProxy}
                    onChange={(event) => setEditProxy(event.target.value)}
                    placeholder="留空走全局代理，例如 http://127.0.0.1:7890"
                  />
                  <Button
                    variant="outline"
                    className="sm:w-24"
                    onClick={() => void handleTestAccountProxy()}
                    disabled={isTestingProxy}
                  >
                    {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                    测试
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setEditingAccount(null)}
              disabled={isUpdating}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleUpdateAccount()}
              disabled={isUpdating}
            >
              {isUpdating ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col border-b border-border lg:flex-row lg:items-center lg:justify-between lg:pr-2.5">
            <div role="group" aria-label="按状态筛选" className="flex overflow-x-auto px-1">
              {statusTabs.map((tab) => {
                const active = statusFilter === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setStatusFilter(tab.value);
                      setPage(1);
                    }}
                    className={cn(
                      "relative inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                      active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.value !== "all" ? (
                      <span aria-hidden="true" className={cn("size-1.5 rounded-full", statusDotClass[tab.value])} />
                    ) : null}
                    {tab.label}
                    <AnimatedNumber
                      value={statusCounts[tab.value]}
                      duration={0.6}
                      className="font-semibold text-foreground tabular-nums"
                    />
                    {active ? (
                      <motion.span
                        layoutId="account-status-tab"
                        transition={SPRING_LAYOUT}
                        className="absolute inset-x-2.5 -bottom-px h-0.5 rounded-full bg-foreground"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 lg:p-0">
              {statusFilter === "异常" && abnormalTokens.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void handleDeleteTokens(abnormalTokens)}
                  disabled={isDeleting}
                >
                  {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  移除全部异常
                </Button>
              ) : null}
              <SearchInput
                size="sm"
                value={query}
                onValueChange={(value) => {
                  setQuery(value);
                  setPage(1);
                }}
                placeholder="搜索邮箱"
                className="w-full sm:w-[220px]"
              />
              <Select
                value={typeFilter}
                onValueChange={(value) => {
                  setTypeFilter(value);
                  setPage(1);
                }}
              >
                <SelectTrigger aria-label="账号类型" className="h-8 w-full rounded-lg px-2.5 text-[13px] sm:w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accountTypeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 批量刷新 / 恢复的进度：只在执行时出现，贴着表格顶部 */}
          {progress.visible ? (
            <div className="relative flex h-8 items-center justify-between gap-3 border-b border-border px-3.5 text-xs">
              <span className="flex min-w-0 items-center gap-2 text-foreground/80">
                {progress.current < progress.total ? (
                  <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
                ) : null}
                <span className="truncate">
                  {progress.message}
                  {progress.email ? <span className="ml-1.5 text-muted-foreground">{progress.email}</span> : null}
                </span>
              </span>
              <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                {progress.current}/{progress.total}
              </span>
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary/15">
                <div
                  className="h-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ) : null}

          {currentRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1060px] text-left text-[13px] tabular-nums">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border [&>th]:h-8 [&>th]:px-2.5 [&>th]:font-medium [&>th]:whitespace-nowrap">
                    <th className="w-10 !pr-0 !pl-3.5">
                      <Checkbox
                        aria-label="全选本页"
                        checked={allCurrentSelected ? true : someCurrentSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                      />
                    </th>
                    <th>账号</th>
                    <th>状态</th>
                    <th>类型</th>
                    <th className="text-right">额度</th>
                    <th>恢复</th>
                    <th>健康</th>
                    <th className="text-right">在途</th>
                    <th className="text-right">成功</th>
                    <th className="text-right">失败</th>
                    <th>代理</th>
                    <th>创建</th>
                    <th className="w-[92px]">
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {currentRows.map((account) => {
                    const selected = selectedIds.includes(account.access_token);
                    const label = account.email ?? maskToken(account.access_token);
                    const health = getHealthInfo(account);
                    const restore = formatRestoreAt(account.restore_at);
                    const inflight = account.image_inflight ?? 0;
                    const isRowRefreshing = refreshingTokens.has(account.access_token);

                    return (
                      <tr
                        key={account.access_token}
                        data-selected={selected || undefined}
                        className="group border-b border-border/70 text-foreground/80 transition-colors last:border-b-0 hover:bg-accent/60 data-[selected]:bg-primary/[0.06] [&>td]:h-8 [&>td]:px-2.5 [&>td]:whitespace-nowrap"
                      >
                        <td className="!pr-0 !pl-3.5">
                          <Checkbox
                            aria-label={`选择 ${label}`}
                            checked={selected}
                            onCheckedChange={(checked) => {
                              setSelectedIds((prev) =>
                                checked
                                  ? Array.from(new Set([...prev, account.access_token]))
                                  : prev.filter((item) => item !== account.access_token),
                              );
                            }}
                          />
                        </td>
                        <td>
                          <div className="flex max-w-[280px] items-center gap-1">
                            <span className="truncate text-foreground" title={account.email ?? undefined}>
                              {label}
                            </span>
                            <button
                              type="button"
                              aria-label="复制 token"
                              title="复制 token"
                              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                              onClick={() => {
                                void navigator.clipboard.writeText(account.access_token);
                                toast.success("token 已复制");
                              }}
                            >
                              <Copy className="size-3.5" />
                            </button>
                          </div>
                        </td>
                        <td>
                          <span className={cn("inline-flex items-center gap-1.5", statusTextClass[account.status])}>
                            <span aria-hidden="true" className={cn("size-1.5 rounded-full", statusDotClass[account.status])} />
                            {account.status}
                          </span>
                        </td>
                        <td>
                          {displayAccountType(account)}
                          <span className="text-muted-foreground"> · {displayAccountSource(account)}</span>
                        </td>
                        <td className="text-right font-mono text-xs">
                          {account.quota > 0 ? (
                            <span className="font-semibold text-info">{formatQuota(account)}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="text-xs">
                          {restore.relative ? (
                            <span title={restore.absolute}>{restore.relative}</span>
                          ) : (
                            <span className="text-muted-foreground">{restore.absolute}</span>
                          )}
                        </td>
                        <td>
                          <span className={cn("inline-flex items-center gap-1.5 text-xs", health.colorClass)} title={health.tooltip}>
                            <span className="font-semibold">{health.score}</span>
                            {health.label}
                            {health.cooldownLeft > 0 ? ` ${Math.ceil(health.cooldownLeft / 60)}m` : ""}
                          </span>
                        </td>
                        <td className="text-right font-mono text-xs">
                          <span
                            className={inflight > 0 ? "font-semibold text-warning" : "text-muted-foreground"}
                            title={
                              inflight > 0
                                ? "当前正在生成的图片数。号池空闲时此值持续 > 0，说明并发槽位泄漏、该账号已被静默排除出调度"
                                : "当前无在途生图任务"
                            }
                          >
                            {inflight}
                          </span>
                        </td>
                        <td className="text-right font-mono text-xs">{account.success}</td>
                        <td className="text-right font-mono text-xs text-muted-foreground">{account.fail}</td>
                        <td className="text-xs">
                          <AccountProxyCell account={account} poolEnabled={poolEnabled} poolItemsById={poolItemsById} />
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {formatCreatedAt((account as Account & { created_at?: string | null }).created_at)}
                        </td>
                        <td>
                          <div
                            className={cn(
                              "flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
                              isRowRefreshing ? "opacity-100" : "",
                            )}
                          >
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7 rounded-md text-muted-foreground"
                              aria-label={`编辑 ${label}`}
                              title="编辑状态和代理"
                              onClick={() => openEditDialog(account)}
                              disabled={isUpdating}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7 rounded-md text-muted-foreground"
                              aria-label={`刷新 ${label}`}
                              title="刷新信息和额度"
                              onClick={() => void handleRefreshAccounts([account.access_token])}
                              disabled={isRefreshing || isRowRefreshing}
                            >
                              <RefreshCw className={cn("size-3.5", isRefreshing || isRowRefreshing ? "animate-spin" : "")} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7 rounded-md text-destructive hover:text-destructive"
                              aria-label={`删除 ${label}`}
                              title="删除"
                              onClick={() => void handleDeleteTokens([account.access_token])}
                              disabled={isDeleting}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : isLoading ? (
            <EmptyState
              icon={<LoaderCircle className="animate-spin" />}
              title="正在加载账户"
              description="从后端同步账号列表和状态。"
            />
          ) : accounts.length === 0 ? (
            <EmptyState icon={<Search />} title="号池里还没有账号" description="点击右上角「导入」添加账号。" />
          ) : (
            <EmptyState icon={<Search />} title="没有匹配的账户" description="调整筛选条件或搜索关键字后重试。" />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {filteredAccounts.length === 0
                ? "共 0 条"
                : `${startIndex + 1}–${Math.min(startIndex + Number(pageSize), filteredAccounts.length)} 条，共 ${filteredAccounts.length} 条`}
            </span>
            <div className="flex items-center gap-1">
              <Select
                value={pageSize}
                onValueChange={(value) => {
                  setPageSize(value);
                  setPage(1);
                }}
              >
                <SelectTrigger aria-label="每页条数" className="h-7 w-[92px] rounded-md px-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 / 页</SelectItem>
                  <SelectItem value="20">20 / 页</SelectItem>
                  <SelectItem value="50">50 / 页</SelectItem>
                  <SelectItem value="100">100 / 页</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                className="size-7 rounded-md"
                aria-label="上一页"
                disabled={safePage <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              {paginationItems.map((item, index) =>
                item === "..." ? (
                  <span key={`ellipsis-${index}`} className="px-1">
                    ...
                  </span>
                ) : (
                  <Button
                    key={item}
                    variant={item === safePage ? "default" : "ghost"}
                    size="sm"
                    className="h-7 min-w-7 rounded-md px-2 text-xs"
                    aria-current={item === safePage ? "page" : undefined}
                    onClick={() => setPage(item)}
                  >
                    {item}
                  </Button>
                ),
              )}
              <Button
                variant="outline"
                size="icon-sm"
                className="size-7 rounded-md"
                aria-label="下一页"
                disabled={safePage >= pageCount}
                onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 批量操作：勾选后浮在内容区底部；列表较短时就跟在表格下面 */}
      <div className="pointer-events-none sticky bottom-4 z-30 flex justify-center empty:hidden">
        <AnimatePresence>
          {selectedTokens.length > 0 ? (
            <motion.div
              key="bulk-actions"
              role="toolbar"
              aria-label="批量操作"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-border-strong bg-foreground p-1 text-background shadow-overlay dark:bg-popover dark:text-popover-foreground"
            >
              <span className="px-2.5 text-[13px] whitespace-nowrap text-background/60 dark:text-muted-foreground">
                已选{" "}
                <span className="font-semibold text-background tabular-nums dark:text-popover-foreground">
                  {selectedTokens.length}
                </span>{" "}
                项
              </span>
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-background/15 dark:bg-border-strong" />
              <Button
                variant="ghost"
                size="sm"
                className={bulkButtonClass}
                onClick={() => void handleRefreshAccounts(selectedTokens)}
                disabled={isRefreshing}
              >
                {isRefreshing ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新额度
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={bulkButtonClass}
                onClick={() => void handleReLogin(selectedTokens)}
                disabled={isRelogining}
                title="尝试密码登录恢复选中的异常账号"
              >
                {isRelogining ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}
                尝试恢复
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={bulkButtonClass}
                onClick={() => void handleResetHealth(selectedTokens)}
                disabled={isResettingHealth}
                title="清除选中账号的健康分/熔断状态，立即重新参与图片调度"
              >
                {isResettingHealth ? <LoaderCircle className="size-4 animate-spin" /> : <HeartPulse className="size-4" />}
                重置健康
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(bulkButtonClass, "text-destructive hover:text-destructive dark:text-destructive dark:hover:text-destructive")}
                onClick={() => void handleDeleteTokens(selectedTokens)}
                disabled={isDeleting}
              >
                {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                删除
              </Button>
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-background/15 dark:bg-border-strong" />
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(bulkButtonClass, "size-7 px-0 text-background/60 dark:text-muted-foreground")}
                aria-label="取消选择"
                title="取消选择"
                onClick={() => setSelectedIds([])}
              >
                <X className="size-4" />
              </Button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </PageEnter>
  );
}

export default function AccountsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return <PageLoader />;
  }

  return <AccountsPageContent />;
}
