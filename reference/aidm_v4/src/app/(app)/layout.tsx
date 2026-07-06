import { PostHogIdentify } from "@/components/posthog-identify";
import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <PostHogIdentify />
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/campaigns" className="text-lg font-semibold tracking-tight">
          AIDM
        </Link>
        <UserButton />
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
    </div>
  );
}
