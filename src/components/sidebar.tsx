"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  CalendarDays,
  Landmark,
  LayoutList,
  MessagesSquare,
  Megaphone,
  Users,
} from "lucide-react";

/**
 * Primary navigation (design doc §2). A left rail rather than a top bar: the
 * Deal Room is a three-pane workspace and vertical space is the scarce
 * resource there — a top bar steals a row from the conversation list and the
 * property card on every screen.
 */
const NAV = [
  { href: "/deal-room", label: "Deal Room", icon: MessagesSquare, hint: "conversations + drafts" },
  { href: "/pipeline", label: "Pipeline", icon: LayoutList, hint: "every deal by stage" },
  { href: "/closings", label: "Closings", icon: CalendarDays, hint: "what actually got paid, and when" },
  { href: "/sellers", label: "Sellers", icon: Users, hint: "contacts and their lots" },
  { href: "/land-bank", label: "Land Bank", icon: Landmark, hint: "checked lots, searchable" },
  { href: "/buyers", label: "Buyers", icon: Building2, hint: "buy boxes" },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, hint: "delivery + agent stats" },
] as const;

export function Sidebar({ signOutSlot, user }: { signOutSlot: React.ReactNode; user: string }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
      <Link href="/deal-room" className="flex items-center gap-2.5 border-b border-border px-4 py-4">
        {/* Wordmark: a parcel outline with the corner pin every plat map has. */}
        <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0" aria-hidden="true">
          <rect x="3" y="6" width="26" height="20" rx="2" className="fill-none stroke-primary" strokeWidth="2" />
          <path d="M3 20 L12 13 L18 18 L29 9" className="fill-none stroke-primary/50" strokeWidth="1.5" />
          <circle cx="24" cy="12" r="3" className="fill-primary" />
        </svg>
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Premier Edge</span>
          <span className="text-[10px] text-muted-foreground">Premier Equity Co.</span>
        </span>
      </Link>

      <nav className="flex-1 space-y-0.5 p-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.hint}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                active
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <p className="truncate text-[11px] text-muted-foreground" title={user}>
          {user}
        </p>
        {signOutSlot}
      </div>
    </aside>
  );
}
