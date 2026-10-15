"use client";

import { PageHeader } from "@/components/page-header";

export function SettingsHeader() {
  return (
    <PageHeader
      eyebrow="System Settings"
      title="设置"
      description="配置服务参数、用户密钥、备份与第三方连接，修改后记得保存。"
    />
  );
}
