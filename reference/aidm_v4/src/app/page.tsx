import { getCurrentUser } from "@/lib/auth";
import Link from "next/link";

export const runtime = "nodejs";

export default async function HomePage() {
  const user = await getCurrentUser();
  const isSignedIn = user !== null;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">AIDM</h1>
      <p className="text-lg text-muted-foreground">
        Anime-themed long-horizon single-player tabletop RPG dungeon master.
      </p>
      <p className="text-sm text-muted-foreground">
        Walking skeleton (M0). Session Zero and gameplay land in M1–M2.
      </p>
      <div className="flex gap-3 pt-4">
        {isSignedIn ? (
          <Link
            href="/campaigns"
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            Continue →
          </Link>
        ) : (
          <>
            <Link
              href="/sign-in"
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Sign up
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
