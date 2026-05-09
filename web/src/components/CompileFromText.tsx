import { useState } from "react";
import { api } from "../api.ts";
import { type Block } from "../blocks.ts";
import { flagBlock, flagBlocks } from "../state/compileFlags.ts";

export function CompileFromText({
  disabled,
  existingCount,
  onApply,
}: {
  disabled?: boolean;
  existingCount: number;
  onApply: (blocks: Block[], mode: "replace" | "append") => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setProposed(null);
    try {
      const { blocks } = await api.compileBlocks(text);
      if (blocks.length === 0) {
        setError("Model returned no blocks. Try rephrasing or being more specific.");
      } else {
        setProposed(blocks);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = (mode: "replace" | "append") => {
    if (!proposed) return;
    if (mode === "replace" && existingCount > 0) {
      if (!confirm(`Replace existing ${existingCount} block${existingCount === 1 ? "" : "s"}?`))
        return;
    }
    onApply(proposed, mode);
    setProposed(null);
    setText("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="self-start rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/20 disabled:opacity-40"
      >
        ✨ Compile from text…
      </button>
    );
  }

  return (
    <div className="rounded-md border border-violet-500/40 bg-violet-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-violet-300">
          ✨ Compile from text
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setProposed(null);
            setError(null);
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Close
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy || !!proposed}
        placeholder={`Paste your task description, e.g.:\n\n1. Go to https://example.com/login\n2. Find the Sign In button and click it\n3. Fill the email field with my@email.com\n4. Submit and verify the dashboard loaded`}
        className="min-h-[120px] w-full resize-none rounded border border-violet-500/30 bg-zinc-950/50 p-2 font-mono text-sm leading-relaxed text-zinc-100 focus:border-violet-500/60 focus:outline-none disabled:opacity-60"
      />

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-200">
          {error}
        </div>
      )}

      {!proposed && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">
            One LLM call. Output is editable before you run.
          </span>
          <button
            type="button"
            onClick={generate}
            disabled={busy || !text.trim()}
            className="rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {busy ? "Generating…" : "Generate blocks"}
          </button>
        </div>
      )}

      {proposed && (
        <div className="space-y-2">
          {(() => {
            const flags = flagBlocks(proposed);
            if (flags.length === 0) return null;
            return (
              <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                <div className="font-semibold">
                  Review carefully — {flags.length} block{flags.length === 1 ? "" : "s"} flagged
                </div>
                <div className="mt-0.5 text-[11px] text-amber-200/80">
                  This compile produced steps that touch off-host URLs or credential-shaped
                  fields. Confirm each is intended before applying.
                </div>
              </div>
            );
          })()}
          <div className="rounded border border-violet-500/30 bg-zinc-950/50 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-violet-300">
              Preview · {proposed.length} block{proposed.length === 1 ? "" : "s"}
            </div>
            <ol className="space-y-0.5 text-xs text-zinc-200">
              {proposed.map((b, i) => {
                const flag = flagBlock(b);
                return (
                  <li key={b.id} className="flex gap-2">
                    <span className="text-zinc-500">{i + 1}.</span>
                    <span className="font-semibold text-violet-300">{b.kind}</span>
                    <span className="truncate text-zinc-400">{shortSummary(b)}</span>
                    {flag && (
                      <span
                        className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-semibold text-amber-200"
                        title={flag.reason}
                      >
                        {flag.reason}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setProposed(null);
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Edit prompt
            </button>
            {existingCount > 0 && (
              <button
                type="button"
                onClick={() => apply("append")}
                className="rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-xs font-medium text-violet-200 hover:bg-violet-500/20"
              >
                Append
              </button>
            )}
            <button
              type="button"
              onClick={() => apply("replace")}
              className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-500"
            >
              {existingCount > 0 ? "Replace existing" : "Apply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function shortSummary(b: Block): string {
  switch (b.kind) {
    case "navigate":
      return b.url;
    case "click":
      return `${b.role && b.role !== "any" ? `[${b.role}] ` : ""}${b.target}`;
    case "fill":
      return `${b.target} ← ${b.value}`;
    case "extract":
      return `${b.target} → $${b.var_name}`;
    case "goal":
      return b.description;
    case "verify":
      return b.condition;
    case "questionnaire":
      return b.context?.trim() ? b.context : "(no context)";
    case "pause":
      return b.message?.trim() ? b.message : "(no message)";
    case "for_each":
      return `${b.items} (${b.body.length} sub-blocks)`;
  }
}
