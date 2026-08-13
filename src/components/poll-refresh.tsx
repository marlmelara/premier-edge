"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Poll-with-revalidate (design doc §3): re-renders the active server view
 * every few seconds. Deliberately not websockets — two users.
 */
export function PollRefresh({ intervalMs = 7000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
