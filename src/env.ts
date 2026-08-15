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
  /**
   * Sendivo's webhook signing secret (`whsec_…`, added to their UI ~Aug 15 2026).
   * Optional: the URL token is the primary gate. When set, deliveries are
   * checked against it — see the webhook route.
   */
  SENDIVO_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  /** Optional pin for which number notifications send from; otherwise the account default. */
  SENDIVO_FROM_NUMBER_ID: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  SIGNWELL_API_KEY: z.string().optional(),
  /** Webhook secret id — also the HMAC key SignWell signs events with. */
  SIGNWELL_WEBHOOK_ID: z.string().optional(),
  SIGNWELL_PSA_TEMPLATE_ID: z.string().optional(),
  /** Template placeholder names — matched by name, not positional id. */
  SIGNWELL_PSA_SELLER_ROLE: z.string().optional(),
  SIGNWELL_PSA_BUYER_ROLE: z.string().optional(),
  SIGNWELL_ASSIGNMENT_TEMPLATE_ID: z.string().optional(),
  SIGNWELL_ASSIGNMENT_BUYER_ROLE: z.string().optional(),
  SIGNWELL_ASSIGNMENT_ASSIGNOR_ROLE: z.string().optional(),
  /** The entity that signs as buyer/assignor on our side. */
  BUYER_ENTITY_NAME: z.string().optional(),
  SIGNWELL_TEST_MODE: z.string().optional(),
  /** Title-company email delivery. */
  RESEND_API_KEY: z.string().optional(),
  TITLE_EMAIL_FROM: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Marlon's cell — destination for §11b alerts and the daily briefing. */
  MARLON_PHONE: z.string().optional(),
  /** CC'd on title emails so Marlon has the paper trail in his inbox. */
  MARLON_EMAIL: z.string().optional(),
  /** Vercel sends this as `Authorization: Bearer` on cron invocations. */
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated at first use (not import) so builds don't require a full env. */
export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
