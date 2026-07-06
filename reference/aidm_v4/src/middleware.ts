import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Routes under the (app) route group require auth. Everything else — landing page,
// sign-in/sign-up, webhooks, health/ready — is public.
const isProtected = createRouteMatcher(["/campaigns(.*)", "/settings(.*)", "/admin(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals and all static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes so auth context is populated.
    "/(api|trpc)(.*)",
  ],
};
