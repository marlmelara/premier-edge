import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

/** Everything inside (crm) requires a session. Webhooks and /login live outside. */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div className="flex items-baseline gap-6">
          <span className="font-semibold">Premier Edge</span>
          <nav className="flex gap-4 text-sm text-zinc-400">
            <span className="cursor-default" title="M2">Deal Room</span>
            <span className="cursor-default" title="M2">Pipeline</span>
            <span className="cursor-default" title="M2">Campaigns</span>
          </nav>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button type="submit" className="text-sm text-zinc-400 hover:text-zinc-100">
            {session.user.name ?? session.user.email} · Sign out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
