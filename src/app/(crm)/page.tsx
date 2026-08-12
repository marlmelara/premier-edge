import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * M0 placeholder home: proves the ingest path end-to-end by listing the latest
 * inbound messages. Replaced by the Deal Room in M2.
 */
export default async function Home() {
  const recent = await getDb().query.messages.findMany({
    orderBy: desc(messages.createdAt),
    limit: 20,
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-lg font-semibold">Inbound messages</h1>
      <p className="mt-1 text-sm text-zinc-400">
        M0 smoke view — everything the Sendivo webhook has persisted. The Deal Room replaces this in M2.
      </p>
      <ul className="mt-6 divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {recent.length === 0 && (
          <li className="px-4 py-6 text-sm text-zinc-500">
            Nothing yet. POST a test payload to /api/webhooks/sendivo to see it land here.
          </li>
        )}
        {recent.map((m) => (
          <li key={m.id} className="px-4 py-3">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>{m.direction}</span>
              <span>{m.createdAt.toISOString()}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-100">{m.body}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
