"use client";

import { useState, useTransition } from "react";
import { setContactLabelsAction } from "@/app/(crm)/actions";
import { GROUP_LABEL, LABELS, styleFor, type LabelGroup } from "@/lib/labels";

/**
 * Label chips on a contact. Click to toggle, saves immediately — tagging is a
 * glance-and-move action, and a save button would make it feel like paperwork.
 */
export function LabelPicker({ contactId, current }: { contactId: string; current: string[] }) {
  const [selected, setSelected] = useState<string[]>(current);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (name: string) => {
    const next = selected.includes(name) ? selected.filter((l) => l !== name) : [...selected, name];
    // Optimistic: the chip flips now, the write follows. A reverted chip on
    // failure is clearer than a half-second of nothing happening.
    setSelected(next);
    setError(null);
    startTransition(async () => {
      const result = await setContactLabelsAction(contactId, next);
      if (!result.ok) {
        setSelected(selected);
        setError("could not save");
      }
    });
  };

  const groups: LabelGroup[] = ["motivation", "obstacle", "logistics"];

  return (
    <div className="space-y-1.5" data-testid="label-picker">
      <div className="flex flex-wrap items-center gap-1">
        {selected.length === 0 && !open && <span className="text-[11px] text-muted-foreground">No labels</span>}
        {selected.map((name) => (
          <button
            key={name}
            type="button"
            disabled={pending}
            onClick={() => toggle(name)}
            title="Click to remove"
            className={`rounded border px-1.5 py-0.5 text-[10px] ${styleFor(name)} disabled:opacity-50`}
          >
            {name} ×
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {open ? "Done" : "+ Label"}
        </button>
      </div>

      {open && (
        <div className="space-y-2 rounded border border-border p-2">
          {groups.map((group) => (
            <div key={group}>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{GROUP_LABEL[group]}</p>
              <div className="flex flex-wrap gap-1">
                {LABELS.filter((l) => l.group === group).map((def) => {
                  const on = selected.includes(def.name);
                  return (
                    <button
                      key={def.name}
                      type="button"
                      disabled={pending}
                      title={def.hint}
                      onClick={() => toggle(def.name)}
                      className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50 ${
                        on ? styleFor(def.name) : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {def.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
