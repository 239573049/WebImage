import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { ThemeScript } from "@/components/theme-script";
import { SideNav } from "@/components/side-nav";

export const metadata: Metadata = {
  title: "ChatGPT 号池管理",
  description: "ChatGPT account pool management dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0ebe3" },
    { media: "(prefers-color-scheme: dark)", color: "#12110f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-dvh overflow-hidden" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body
        className="h-dvh overflow-hidden antialiased"
        style={{
          fontFamily:
            '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
        }}
      >
        <Toaster position="top-center" richColors offset={48} />
        <main className="flex h-dvh flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.92),_rgba(245,239,231,0.96)_42%,_rgba(240,235,227,0.99)_100%)] text-stone-900 transition-colors duration-300 dark:bg-[radial-gradient(circle_at_top_left,_rgba(55,48,43,0.72),_rgba(28,25,23,0.98)_40%,_rgba(12,10,9,1)_100%)] dark:text-stone-100">
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <SideNav />
            {/* 外层负责留白，内层负责滚动；避免 padding + h-full 叠出多余滚动条 */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pt-[env(safe-area-inset-top)] pb-2 sm:px-6 sm:py-4 lg:px-8">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [&>*]:min-h-0">
                {children}
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
