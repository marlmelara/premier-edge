import { Redis } from "@upstash/redis";
import { env } from "@/env";

let cached: Redis | null | undefined;

/** Upstash Redis, or null when unconfigured — callers must degrade gracefully. */
export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = env();
  cached = url && token ? new Redis({ url, token }) : null;
  return cached;
}
