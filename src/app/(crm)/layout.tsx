import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { Sidebar } from "@/components/sidebar";

/** Everything inside (crm) requires a session. Webhooks and /login live outside. */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    // h-screen + overflow-hidden so the sidebar stays put and each page scrolls
    // its own panes — the Deal Room's three columns scroll independently.
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        user={session.user.name ?? session.user.email ?? "signed in"}
        signOutSlot={
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button type="submit" className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
              Sign out
            </button>
          </form>
        }
      />
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
