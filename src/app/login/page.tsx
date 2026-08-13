import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";

export const metadata = { title: "Sign in — Premier Edge" };

async function login(formData: FormData) {
  "use server";
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect("/login?error=1");
    }
    throw error; // NEXT_REDIRECT must propagate
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <form action={login} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-8">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Premier Edge</h1>
          <p className="text-sm text-muted-foreground">Premier Equity Co. LLC</p>
        </div>
        {error && <p className="text-sm text-red-400">Invalid email or password.</p>}
        <label className="block text-sm text-foreground">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-foreground outline-none focus:border-ring"
          />
        </label>
        <label className="block text-sm text-foreground">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-foreground outline-none focus:border-ring"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
