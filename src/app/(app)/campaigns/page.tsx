import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

export default async function CampaignsPage() {
  const user = await getCurrentUser();
  const greeting = user?.email ?? user?.id ?? "stranger";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">hello, {greeting}</h1>
      <p className="text-muted-foreground">
        No campaigns yet. Campaign creation + Session Zero land in M2.
      </p>
    </div>
  );
}
