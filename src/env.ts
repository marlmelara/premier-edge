import { z } from "zod";

const authUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  passwordHash: z.string().min(1),
});

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  AUTH_USERS: z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "AUTH_USERS must be valid JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.array(authUserSchema).min(1)),
  SENDIVO_API_KEY: z.string().optional(),
  SENDIVO_WEBHOOK_TOKEN: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  SIGNWELL_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated at first use (not import) so builds don't require a full env. */
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
