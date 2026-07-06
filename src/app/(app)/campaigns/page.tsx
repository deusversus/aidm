import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

// Placeholder landing spot for Clerk's post-auth redirect. The campaign
// shelf (blueprint §9.1) lands at M1.
export default async function CampaignsPage() {
  const user = await getCurrentUser();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
      <p className="text-sm text-muted-foreground">
        Signed in{user?.email ? ` as ${user.email}` : ""}. The campaign shelf lands at M1.
      </p>
    </main>
  );
}
