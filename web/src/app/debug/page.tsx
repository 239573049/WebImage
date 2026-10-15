"use client";

import { LoaderCircle } from "lucide-react";

import { PageEnter } from "@/components/page-enter";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthGuard } from "@/lib/use-auth-guard";

import { ChatPanel } from "./components/chat-panel";
import { PptPanel } from "./components/ppt-panel";
import { PsdPanel } from "./components/psd-panel";
import { SearchPanel } from "./components/search-panel";
import { SkillPanel } from "./components/skill-panel";

const tabs = [
  { value: "skills", title: "搜索Skills" },
  { value: "search", title: "搜索" },
  { value: "ppt", title: "PPT生成" },
  { value: "psd", title: "PSD生成" },
  { value: "chat", title: "对话" },
];

export default function DebugPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <PageEnter className="flex h-full min-h-0 w-full flex-col gap-4">
      <PageHeader title="调试" />
      <Tabs defaultValue="skills" className="flex h-full min-h-0 w-full flex-col gap-4">
        <div className="hide-scrollbar max-w-full shrink-0 overflow-x-auto">
          <TabsList className="w-fit">
            {tabs.map(({ value, title }) => (
              <TabsTrigger key={value} value={value}>
                {title}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="skills" className="min-h-0 overflow-y-auto">
          <SkillPanel />
        </TabsContent>
        <TabsContent value="search" className="min-h-0 overflow-hidden">
          <SearchPanel />
        </TabsContent>
        <TabsContent value="ppt" className="min-h-0 overflow-hidden">
          <PptPanel />
        </TabsContent>
        <TabsContent value="psd" className="min-h-0 overflow-hidden">
          <PsdPanel />
        </TabsContent>
        <TabsContent value="chat" className="min-h-0 overflow-hidden">
          <ChatPanel />
        </TabsContent>
      </Tabs>
    </PageEnter>
  );
}
