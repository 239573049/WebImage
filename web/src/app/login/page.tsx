"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { HeaderActions } from "@/components/header-actions";
import { Input } from "@/components/motion/input";
import { PageLoader } from "@/components/page-loader";
import { BrandMark } from "@/components/shell/brand";
import { Button } from "@/components/ui/button";
import { login } from "@/lib/api";
import { pageFadeUp } from "@/lib/motion";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function LoginPage() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [authKey, setAuthKey] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const handleLogin = async () => {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
      setError("请输入密钥");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await login(normalizedAuthKey);
      await setStoredAuthSession({
        key: normalizedAuthKey,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      setError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth) {
    return <PageLoader className="h-full" />;
  }

  return (
    <div className="relative grid h-full min-h-0 w-full place-items-center overflow-y-auto px-4 py-10">
      <HeaderActions className="fixed top-4 right-4 z-10" />
      <motion.div
        className="w-full max-w-[400px] space-y-6"
        initial={reduceMotion ? false : "hidden"}
        animate="show"
        variants={reduceMotion ? undefined : pageFadeUp}
      >
        <BrandMark className="px-1" />

        <div className="surface-raised space-y-6 rounded-[20px] p-6 sm:p-7">
          <div className="space-y-2.5">
            <div className="eyebrow">Sign in</div>
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-foreground">登录控制台</h1>
            <p className="text-sm leading-6 text-muted-foreground">输入密钥后继续使用号池管理和图片生成功能。</p>
          </div>

          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLogin();
            }}
          >
            <Input
              id="auth-key"
              type="password"
              label="密钥"
              autoComplete="current-password"
              placeholder="请输入密钥"
              value={authKey}
              onChange={(value) => {
                setAuthKey(value);
                if (error) setError("");
              }}
              error={error || undefined}
              reserveErrorLine
              leftIcon={<KeyRound />}
              classNames={{
                label: "px-0 text-[13px] text-foreground/80",
                field: "rounded-xl border-input bg-field hover:border-border-strong",
                input: "text-[15px]",
              }}
            />

            <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              登录
            </Button>
          </form>
        </div>

        <p className="px-1 text-center text-xs leading-5 text-muted-foreground">
          管理员密钥可进入全部功能；普通用户密钥只能使用画图。
        </p>
      </motion.div>
    </div>
  );
}
