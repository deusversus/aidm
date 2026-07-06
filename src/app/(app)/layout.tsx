import { PostHogIdentify } from "@/components/posthog-identify";
import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PostHogIdentify />
      {children}
    </>
  );
}
