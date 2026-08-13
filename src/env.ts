import { z } from "zod";

const authUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  // Shape-checked so a hash mangled by dotenv's `$` expansion fails loudly at
  // startup instead of silently rejecting every login. Escape each `$` as `\$`
  // in .env files (see .env.example).
  passwordHash: z
    .string()
    .regex(
      /^\$2[aby]\$\d{2}\$.{53}$/,
      "passwordHash is not a valid bcrypt hash — in .env files each `$` must be escaped as `\\$`",
    ),
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
  /** Marlon's cell — destination for §11b alerts and the daily briefing. */
  MARLON_PHONE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated at first use (not import) so builds don't require a full env. */
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
