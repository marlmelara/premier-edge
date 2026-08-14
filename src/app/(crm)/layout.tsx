import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

/** Everything inside (crm) requires a session. Webhooks and /login live outside. */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-baseline gap-6">
          <Link href="/deal-room" className="font-semibold">
            Premier Edge
          </Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/deal-room" className="hover:text-foreground">
              Deal Room
            </Link>
            <Link href="/pipeline" className="hover:text-foreground">
              Pipeline
            </Link>
            <Link href="/campaigns" className="hover:text-foreground">
              Campaigns
            </Link>
            <Link href="/buyers" className="hover:text-foreground">
              Buyers
            </Link>
            <Link href="/land-bank" className="hover:text-foreground">
              Land Bank
            </Link>
          </nav>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button type="submit" className="text-sm text-muted-foreground hover:text-foreground">
            {session.user.name ?? session.user.email} · Sign out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
