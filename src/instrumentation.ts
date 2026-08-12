import dns from "node:dns";

export function register() {
  // hazards.fema.gov publishes broken IPv6 — Node resolves AAAA first and the
  // connection resets. Prefer IPv4 process-wide (verified Aug 12, 2026).
  dns.setDefaultResultOrder("ipv4first");
}
