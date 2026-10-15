"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type ChangeEvent, type ComponentProps } from "react";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FileJson,
  FileText,
  Files,
  KeyRound,
  LoaderCircle,
  LogIn,
  ServerCog,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createAccounts,
  finishOAuthLogin,
  startOAuthLogin,
  type Account,
  type AccountImportPayload,
  type OAuthLoginStartResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  describeSub2ApiSkips,
  getAccountJsonAccounts,
  getCodexAuthAccount,
  getSessionAccessToken,
  mergeSub2ApiResults,
  parseSub2ApiExport,
  parseSub2ApiText,
  splitTokens,
  type Sub2ApiParseResult,
} from "./account-import-parsers";

type ImportMethod = "menu" | "token" | "session" | "codex-auth" | "account-json" | "sub2api-json" | "oauth";

type AccountImportDialogProps = {
  disabled?: boolean;
  /** 触发按钮尺寸，号池页的紧凑页头用 sm */
  size?: ComponentProps<typeof Button>["size"];
  onImported: (items: Account[]) => void;
};

type PendingAccountJsonImport = {
  tokens: string[];
  accounts: AccountImportPayload[];
  parsedAccountCount: number;
  errorCount: number;
  skippedPlatformCount?: number;
  successText?: string;
};

const sessionUrl = "https://chatgpt.com/api/auth/session";

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error(`读取文件失败: ${file.name}`));
    reader.readAsText(file);
  });
}

const METHOD_TITLES: Record<ImportMethod, string> = {
  menu: "导入账户",
  token: "导入 Access Token",
  session: "导入 Session JSON",
  "codex-auth": "导入 Codex 认证 JSON",
  "account-json": "导入账号 JSON",
  "sub2api-json": "导入 Sub2API 导出 JSON",
  oauth: "OAuth 登录已有账号",
};

const METHOD_DESCRIPTIONS: Record<ImportMethod, string> = {
  menu: "选择一种导入方式。导入成功后会自动拉取邮箱、类型和额度。",
  token: "支持手动粘贴或从 TXT 文件导入，一行一个 Token。",
  session: "粘贴完整 Session JSON，系统会自动提取 accessToken。",
  "codex-auth": "粘贴 Codex 认证 JSON，系统会按 codex 来源导入。",
  "account-json": "支持读取本项目、CPA 或 Sub2API 导出的账号 JSON，并在提交前做数量确认。",
  "sub2api-json": "粘贴或选择 Sub2API 导出的账号 JSON，系统会展开 accounts[].credentials 并在提交前做数量确认。",
  oauth: "用浏览器跑一遍 OpenAI 标准 OAuth，拿回 refresh_token 后系统会自动续期。",
};

function MethodCard({
  title,
  description,
  icon: Icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: typeof KeyRound;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full rounded-2xl text-left outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
    >
      <Card className="transition-colors group-hover:bg-accent">
        <CardContent className="flex items-start gap-4 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Icon className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold text-foreground">{title}</div>
            <div className="text-[13px] leading-6 text-muted-foreground">{description}</div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

export function AccountImportDialog({ disabled, size, onImported }: AccountImportDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<ImportMethod>("menu");
  const [tokenInput, setTokenInput] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [codexAuthInput, setCodexAuthInput] = useState("");
  const [sub2apiJsonInput, setSub2apiJsonInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingAccountJsonImport, setPendingAccountJsonImport] = useState<PendingAccountJsonImport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [oauthEmailHint, setOauthEmailHint] = useState("");
  const [oauthSession, setOauthSession] = useState<OAuthLoginStartResponse | null>(null);
  const [oauthCallbackInput, setOauthCallbackInput] = useState("");
  const [oauthStarting, setOauthStarting] = useState(false);

  const txtInputRef = useRef<HTMLInputElement | null>(null);
  const accountJsonInputRef = useRef<HTMLInputElement | null>(null);
  const sub2apiJsonInputRef = useRef<HTMLInputElement | null>(null);

  const sub2apiTextPreview = useMemo(() => parseSub2ApiText(sub2apiJsonInput), [sub2apiJsonInput]);

  const resetState = () => {
    setMethod("menu");
    setTokenInput("");
    setSessionInput("");
    setCodexAuthInput("");
    setSub2apiJsonInput("");
    setPendingAccountJsonImport(null);
    setConfirmOpen(false);
    setOauthEmailHint("");
    setOauthSession(null);
    setOauthCallbackInput("");
    setOauthStarting(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      resetState();
    }
  };

  const submitTokens = async (tokens: string[], successText?: string, accountPayloads: AccountImportPayload[] = []) => {
    const normalizedTokens = tokens.map((item) => item.trim()).filter(Boolean);

    if (normalizedTokens.length === 0) {
      toast.error("请先提供至少一个可用 Token");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await createAccounts(normalizedTokens, accountPayloads);
      onImported(data.items);
      setOpen(false);
      resetState();

      if ((data.errors?.length ?? 0) > 0) {
        const firstError = data.errors?.[0]?.error;
        toast.error(
          `${successText ?? "导入完成"}，新增 ${data.added ?? 0} 个，已刷新 ${data.refreshed ?? 0} 个，失败 ${data.errors?.length ?? 0} 个${firstError ? `，首个错误：${firstError}` : ""}`,
        );
      } else {
        toast.success(
          `${successText ?? "导入完成"}，新增 ${data.added ?? 0} 个，跳过 ${data.skipped ?? 0} 个重复项，已自动刷新账号信息`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "导入账户失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImportTokenText = async () => {
    await submitTokens(splitTokens(tokenInput), "Access Token 导入完成");
  };

  // 起授权：拿 authorize URL，立刻在新窗口打开，方便用户登录
  const handleStartOAuth = async () => {
    setOauthStarting(true);
    try {
      const data = await startOAuthLogin(oauthEmailHint.trim());
      setOauthSession(data);
      setOauthCallbackInput("");
      if (typeof window !== "undefined") {
        window.open(data.authorize_url, "_blank", "noopener,noreferrer");
      }
      toast.success("已打开 OpenAI 授权页面，请在登录后复制 callback URL 回来");
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth 起始失败";
      toast.error(message);
    } finally {
      setOauthStarting(false);
    }
  };

  // 用粘贴回来的 callback URL 完成换 token + 落盘
  const handleFinishOAuth = async () => {
    if (!oauthSession) {
      toast.error("请先点击\"打开授权页面\"获取 session");
      return;
    }
    const trimmed = oauthCallbackInput.trim();
    if (!trimmed) {
      toast.error("请粘贴 callback URL 或 code");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await finishOAuthLogin(oauthSession.session_id, trimmed);
      onImported(data.items);
      setOpen(false);
      resetState();

      if ((data.errors?.length ?? 0) > 0) {
        const firstError = data.errors?.[0]?.error;
        toast.error(
          `OAuth 登录完成，新增 ${data.added ?? 0} 个，已刷新 ${data.refreshed ?? 0} 个，失败 ${data.errors?.length ?? 0} 个${firstError ? `，首个错误：${firstError}` : ""}`,
        );
      } else {
        toast.success(
          `OAuth 登录完成，新增 ${data.added ?? 0} 个，跳过 ${data.skipped ?? 0} 个重复项，已自动刷新账号信息`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth 换 token 失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 复制 authorize URL 到剪贴板（适配浏览器和 fallback）
  const handleCopyAuthorizeUrl = async () => {
    if (!oauthSession) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(oauthSession.authorize_url);
        toast.success("授权 URL 已复制到剪贴板");
      } else {
        toast.error("当前环境不支持自动复制，请手动选择并复制");
      }
    } catch {
      toast.error("复制失败，请手动选择并复制");
    }
  };

  const handleTxtSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const content = await readFileAsText(file);
      const tokens = splitTokens(content);

      if (tokens.length === 0) {
        toast.error("TXT 文件里没有读取到有效 Token");
        return;
      }

      setTokenInput((prev) => {
        const next = [...splitTokens(prev), ...tokens];
        return next.join("\n");
      });
      toast.success(`已从 ${file.name} 读取 ${tokens.length} 个 Token`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取 TXT 文件失败";
      toast.error(message);
    }
  };

  const handleImportSessionJson = async () => {
    if (!sessionInput.trim()) {
      toast.error("请先粘贴完整 Session JSON");
      return;
    }

    try {
      const payload = JSON.parse(sessionInput) as unknown;
      const token = getSessionAccessToken(payload);

      if (!token) {
        toast.error("未从 Session JSON 中提取到 accessToken");
        return;
      }

      await submitTokens([token], "Session JSON 导入完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Session JSON 解析失败";
      toast.error(message);
    }
  };

  const handleImportCodexAuthJson = async () => {
    if (!codexAuthInput.trim()) {
      toast.error("请先粘贴 Codex 认证 JSON");
      return;
    }

    try {
      const payload = JSON.parse(codexAuthInput) as unknown;
      const account = getCodexAuthAccount(payload);

      if (!account) {
        toast.error("未从 Codex 认证 JSON 中提取到 access_token");
        return;
      }

      await submitTokens([account.access_token], "Codex 认证 JSON 导入完成", [account]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex 认证 JSON 解析失败";
      toast.error(message);
    }
  };

  const handleAccountJsonSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    try {
      const results = await Promise.all(
        files.map(async (file) => {
          const raw = await readFileAsText(file);
          const parsed = JSON.parse(raw) as unknown;
          const accounts = getAccountJsonAccounts(parsed);
          return {
            accounts,
          };
        }),
      );

      const accounts = results.flatMap((item) => item.accounts);
      const tokens = accounts.map((item) => item.access_token);
      const parsedAccountCount = accounts.length;
      const errorCount = results.filter((item) => item.accounts.length === 0).length;

      if (parsedAccountCount === 0) {
        toast.error("这些账号 JSON 文件里没有读取到可用 access_token");
        return;
      }

      setPendingAccountJsonImport({
        tokens,
        accounts,
        parsedAccountCount,
        errorCount,
      });
      setConfirmOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取账号 JSON 文件失败";
      toast.error(message);
    }
  };

  const stageSub2ApiImport = (result: Sub2ApiParseResult, fileErrorCount: number) => {
    if (result.accounts.length === 0) {
      const skips = describeSub2ApiSkips(result);
      toast.error(skips ? `没有读取到可导入的 OpenAI 账号（${skips}）` : "没有从 Sub2API JSON 中读取到可用 access_token");
      return;
    }

    setPendingAccountJsonImport({
      tokens: result.accounts.map((item) => item.access_token),
      accounts: result.accounts,
      parsedAccountCount: result.accounts.length,
      errorCount: fileErrorCount + result.skippedNoToken,
      skippedPlatformCount: result.skippedPlatform,
      successText: "Sub2API JSON 导入完成",
    });
    setConfirmOpen(true);
  };

  const handleParseSub2ApiText = () => {
    if (!sub2apiJsonInput.trim()) {
      toast.error("请先粘贴 Sub2API 导出的 JSON");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(sub2apiJsonInput) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sub2API JSON 解析失败";
      toast.error(`JSON 格式有误：${message}`);
      return;
    }

    stageSub2ApiImport(parseSub2ApiExport(parsed), 0);
  };

  const handleSub2ApiFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    try {
      const results = await Promise.all(
        files.map(async (file) => {
          const raw = await readFileAsText(file);
          try {
            return parseSub2ApiExport(JSON.parse(raw) as unknown);
          } catch {
            return null;
          }
        }),
      );

      const parsedResults = results.filter((item): item is Sub2ApiParseResult => item !== null);
      const unreadableFiles = results.length - parsedResults.length;
      if (unreadableFiles > 0) {
        toast.error(`有 ${unreadableFiles} 个文件不是合法 JSON，已忽略`);
      }

      stageSub2ApiImport(mergeSub2ApiResults(parsedResults), unreadableFiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取 Sub2API JSON 文件失败";
      toast.error(message);
    }
  };

  const renderMethodBody = () => {
    if (method === "token") {
      const tokenCount = splitTokens(tokenInput).length;

      return (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMethod("menu")}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              返回导入方式
            </button>
            <span className="text-xs text-muted-foreground">当前识别 {tokenCount} 个 Token</span>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground/80">Access Token 列表</label>
            <Textarea
              placeholder="每行一个 Access Token..."
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              className="min-h-56 resize-none font-mono text-xs"
            />
          </div>
          <div className="rounded-2xl border border-dashed border-border bg-field/50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">从 TXT 文件导入</div>
                <div className="text-[13px] leading-6 text-muted-foreground">支持 `.txt`，文件内容也是一行一个 Token。</div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => txtInputRef.current?.click()}
                disabled={isSubmitting}
              >
                <FileText className="size-4" />
                选择 TXT
              </Button>
            </div>
          </div>
          <input
            ref={txtInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(event) => void handleTxtSelected(event)}
          />
        </div>
      );
    }

    if (method === "session") {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMethod("menu")}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回导入方式
          </button>
          <div className="rounded-2xl border border-border bg-field/50 p-4 text-[13px] leading-6 text-foreground/80">
            打开
            {" "}
            <a
              href={sessionUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4"
            >
              {sessionUrl}
              <ExternalLink className="size-3.5" />
            </a>
            ，复制页面返回的完整 JSON，系统会自动提取其中的 `accessToken` 导入。
          </div>
          <div className="rounded-2xl border border-warning/30 bg-warning/12 p-4 text-[13px] leading-6 text-warning">
            <div className="font-medium">风险提示</div>
            <div>
              不要使用自己的大号，尽量使用不常用的小号进行导入，避免出现封号风险。本项目不承担任何封号风险责任。
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground/80">Session JSON</label>
            <Textarea
              placeholder='粘贴完整 JSON，例如包含 "accessToken" 的对象...'
              value={sessionInput}
              onChange={(event) => setSessionInput(event.target.value)}
              className="min-h-56 resize-none font-mono text-xs"
            />
          </div>
        </div>
      );
    }

    if (method === "oauth") {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMethod("menu")}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回导入方式
          </button>
          <div className="space-y-2 rounded-2xl border border-border bg-field/50 p-4 text-[13px] leading-6 text-foreground/80">
            <div className="font-medium text-foreground">操作步骤</div>
            <ol className="list-decimal space-y-1 pl-5">
              <li>（可选）填写你 ChatGPT 账号的邮箱，登录页会预填。</li>
              <li>点击下方"打开授权页面"，在新标签里登录自己的 ChatGPT 账号。</li>
              <li>登录完成后浏览器会跳到 <code className="rounded-md bg-secondary px-1">platform.openai.com/auth/callback?code=...</code>。立刻从地址栏复制整段 URL（或开 F12 在 Network 里抓到 callback 那一行，右键 Copy → Copy URL）。</li>
              <li>把 callback URL 粘到下面输入框，点"完成导入"。</li>
            </ol>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground/80">邮箱（可选预填）</label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={oauthEmailHint}
              onChange={(event) => setOauthEmailHint(event.target.value)}
              disabled={Boolean(oauthSession) || oauthStarting}
            />
          </div>
          {!oauthSession ? (
            <Button
              type="button"
              onClick={() => void handleStartOAuth()}
              disabled={oauthStarting}
            >
              {oauthStarting ? <LoaderCircle className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
              打开授权页面
            </Button>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-field px-3 py-2 font-mono text-xs leading-6 break-all text-foreground/80">
                {oauthSession.authorize_url}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleCopyAuthorizeUrl()}
                >
                  <Copy className="size-4" />
                  复制授权 URL
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => window.open(oauthSession.authorize_url, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="size-4" />
                  再次打开
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setOauthSession(null);
                    setOauthCallbackInput("");
                  }}
                >
                  重新生成
                </Button>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">粘贴 callback URL（或仅 code）</label>
                <Textarea
                  placeholder={"https://platform.openai.com/auth/callback?code=...&state=..."}
                  value={oauthCallbackInput}
                  onChange={(event) => setOauthCallbackInput(event.target.value)}
                  className="min-h-24 resize-none font-mono text-xs"
                />
              </div>
            </div>
          )}
          <div className="rounded-2xl border border-warning/30 bg-warning/12 p-4 text-[13px] leading-6 text-warning">
            <div className="font-medium">注意</div>
            <div>
              授权码（code）只能使用一次。如果浏览器的 callback 页加载完成、显示了 OpenAI 的错误页，那 code 大概率已经被消耗，
              请点击"重新生成"再走一次。整个流程在 10 分钟内完成即可。
            </div>
          </div>
        </div>
      );
    }

    if (method === "account-json") {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMethod("menu")}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回导入方式
          </button>
          <div className="rounded-2xl border border-dashed border-border bg-field/50 p-5">
            <div className="flex items-start gap-4">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Files className="size-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium text-foreground">选择本地账号 JSON 文件</div>
                <div className="text-[13px] leading-6 text-muted-foreground">
                  支持本项目导出的单账号对象或全部账号数组，也兼容 CPA JSON 与 Sub2API 导出文件。
                  系统会自动提取顶层 Token，或 `accounts[].credentials.access_token`。
                </div>
              </div>
            </div>
            <Button
              type="button"
              className="mt-4"
              onClick={() => accountJsonInputRef.current?.click()}
              disabled={isSubmitting}
            >
              <Files className="size-4" />
              选择 JSON 文件
            </Button>
          </div>
          <input
            ref={accountJsonInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={(event) => void handleAccountJsonSelected(event)}
          />
          {pendingAccountJsonImport ? (
            <div className="rounded-2xl border border-border bg-field/50 p-4 text-[13px] leading-6 text-foreground/80">
              最近一次读取到 {pendingAccountJsonImport.parsedAccountCount} 个 Token
              {pendingAccountJsonImport.errorCount > 0 ? `，另有 ${pendingAccountJsonImport.errorCount} 个文件未提取成功` : ""}。
            </div>
          ) : null}
        </div>
      );
    }

    if (method === "sub2api-json") {
      const previewSkips = describeSub2ApiSkips(sub2apiTextPreview);

      return (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMethod("menu")}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              返回导入方式
            </button>
            {sub2apiJsonInput.trim() ? (
              <span className="text-xs text-muted-foreground">
                当前识别 {sub2apiTextPreview.accounts.length} 个 OpenAI 账号
              </span>
            ) : null}
          </div>
          <div className="rounded-2xl border border-border bg-field/50 p-4 text-[13px] leading-6 text-foreground/80">
            粘贴 Sub2API 后台导出的账号 JSON（形如 <code className="rounded-md bg-secondary px-1">{"{ \"accounts\": [...], \"proxies\": [] }"}</code>），
            系统会读取每个账号的 <code className="rounded-md bg-secondary px-1">credentials</code>，保留 refresh_token、id_token 与套餐信息，
            并自动跳过非 OpenAI 平台的账号。
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground/80">Sub2API 导出 JSON</label>
            <Textarea
              placeholder={'粘贴完整导出内容，例如 {"accounts": [{"platform": "openai", "credentials": {...}}]}'}
              value={sub2apiJsonInput}
              onChange={(event) => setSub2apiJsonInput(event.target.value)}
              className="min-h-56 resize-none font-mono text-xs"
            />
            {previewSkips ? <div className="text-xs text-warning">{previewSkips}</div> : null}
          </div>
          <div className="rounded-2xl border border-dashed border-border bg-field/50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">从导出文件导入</div>
                <div className="text-[13px] leading-6 text-muted-foreground">支持一次选择多个 Sub2API 导出的 `.json` 文件。</div>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => sub2apiJsonInputRef.current?.click()}
                disabled={isSubmitting}
              >
                <Files className="size-4" />
                选择 JSON
              </Button>
            </div>
          </div>
          <input
            ref={sub2apiJsonInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={(event) => void handleSub2ApiFilesSelected(event)}
          />
        </div>
      );
    }

    if (method === "codex-auth") {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setMethod("menu")}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            返回导入方式
          </button>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground/80">Codex 认证 JSON</label>
            <Textarea
              placeholder='粘贴包含 "access_token"、"refresh_token"、"id_token" 的 Codex 认证 JSON...'
              value={codexAuthInput}
              onChange={(event) => setCodexAuthInput(event.target.value)}
              className="min-h-64 resize-none font-mono text-xs"
            />
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <MethodCard
          title="OAuth 登录已有账号（带自动刷新）"
          description="用浏览器登录自己的 ChatGPT 账号，回填 callback URL 即可拿到 refresh_token，后台会自动续期。"
          icon={LogIn}
          onClick={() => setMethod("oauth")}
        />
        <MethodCard
          title="导入 Access Token"
          description="支持直接粘贴，一行一个；也支持从 TXT 文件读取，一行一个。"
          icon={KeyRound}
          onClick={() => setMethod("token")}
        />
        <MethodCard
          title="导入 Session JSON"
          description="从 chatgpt.com 的 session 接口复制完整 JSON，自动提取 accessToken。"
          icon={FileJson}
          onClick={() => setMethod("session")}
        />
        <MethodCard
          title="导入 Codex 认证 JSON"
          description="粘贴 Codex 认证 JSON，导入后账号来源标记为 codex。"
          icon={FileJson}
          onClick={() => setMethod("codex-auth")}
        />
        <MethodCard
          title="导入账号 JSON 文件"
          description="支持本项目、CPA 与 Sub2API 导出的账号 JSON 文件。"
          icon={Files}
          onClick={() => setMethod("account-json")}
        />
        <MethodCard
          title="导入 Sub2API 导出 JSON"
          description="粘贴或选择 Sub2API 后台导出的账号 JSON，自动读取 credentials 并跳过非 OpenAI 账号。"
          icon={ServerCog}
          onClick={() => setMethod("sub2api-json")}
        />
        <MethodCard
          title="从远程 CPA 服务器导入"
          description="前往设置页面配置远程 CPA 服务器后再执行导入。"
          icon={Files}
          onClick={() => {
            setOpen(false);
            resetState();
            router.push("/settings");
          }}
        />
        <MethodCard
          title="从 Sub2API 服务器导入"
          description="前往设置页面配置 Sub2API 服务器，再选择其中的 OpenAI 账号导入。"
          icon={ServerCog}
          onClick={() => {
            setOpen(false);
            resetState();
            router.push("/settings");
          }}
        />
      </div>
    );
  };

  const footerDisabled = disabled || isSubmitting;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <Button
          size={size}
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          <Upload className="size-4" />
          导入
        </Button>
        <DialogContent showCloseButton={false} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{METHOD_TITLES[method]}</DialogTitle>
            <DialogDescription>{METHOD_DESCRIPTIONS[method]}</DialogDescription>
          </DialogHeader>

          {renderMethodBody()}

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={footerDisabled}
            >
              取消
            </Button>
            {method === "token" ? (
              <Button
                onClick={() => void handleImportTokenText()}
                disabled={footerDisabled}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                导入 Token
              </Button>
            ) : null}
            {method === "session" ? (
              <Button
                onClick={() => void handleImportSessionJson()}
                disabled={footerDisabled}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                导入 JSON
              </Button>
            ) : null}
            {method === "codex-auth" ? (
              <Button
                onClick={() => void handleImportCodexAuthJson()}
                disabled={footerDisabled}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                导入 JSON
              </Button>
            ) : null}
            {method === "oauth" ? (
              <Button
                className={cn(!oauthSession ? "hidden" : "")}
                onClick={() => void handleFinishOAuth()}
                disabled={footerDisabled || !oauthSession || !oauthCallbackInput.trim()}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                完成导入
              </Button>
            ) : null}
            {method === "sub2api-json" ? (
              <Button
                onClick={() => handleParseSub2ApiText()}
                disabled={footerDisabled || !sub2apiJsonInput.trim()}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                解析并确认
              </Button>
            ) : null}
            {method === "account-json" ? (
              <Button
                className={cn(!pendingAccountJsonImport ? "hidden" : "")}
                onClick={() => setConfirmOpen(true)}
                disabled={footerDisabled || !pendingAccountJsonImport}
              >
                查看导入确认
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>确认导入账号 Token</DialogTitle>
            <DialogDescription>
              {pendingAccountJsonImport
                ? `确认识别到 ${pendingAccountJsonImport.parsedAccountCount} 个 Token，是否确认导入？`
                : "尚未读取到可导入的 Token。"}
              {pendingAccountJsonImport?.errorCount
                ? `，另有 ${pendingAccountJsonImport.errorCount} 个未提取成功。`
                : "。"}
              {pendingAccountJsonImport?.skippedPlatformCount
                ? `已跳过 ${pendingAccountJsonImport.skippedPlatformCount} 个非 OpenAI 平台账号。`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
              disabled={isSubmitting}
            >
              返回
            </Button>
            <Button
              onClick={() =>
                void submitTokens(
                  pendingAccountJsonImport?.tokens ?? [],
                  pendingAccountJsonImport?.successText ?? "账号 JSON 导入完成",
                  pendingAccountJsonImport?.accounts ?? [],
                )
              }
              disabled={isSubmitting || !pendingAccountJsonImport}
            >
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
