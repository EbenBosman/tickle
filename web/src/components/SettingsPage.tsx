import { useEffect, useState } from "react";
import { api, type Settings, type Lesson } from "../api.ts";

const MODELS: { value: string; label: string; cost: string }[] = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", cost: "~$0.02–0.08 / failed block" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", cost: "~$0.10–0.30 / failed block" },
  { value: "claude-opus-4-7", label: "Opus 4.7", cost: "~$0.50–1.50 / failed block" },
];

// ── Shared building blocks ─────────────────────────────────

function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
      {right}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-4 py-3">{children}</div>
  );
}

/**
 * Title + description on the left, optional control on the right. The control
 * is anchored to the top so it stays aligned with the title regardless of
 * description length — fixes the "toggle floats in middle of long text" issue.
 */
function Row({
  title,
  description,
  control,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-200">{title}</div>
          {description && <div className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</div>}
        </div>
        {control && <div className="flex-shrink-0">{control}</div>}
      </div>
    </Card>
  );
}

function Toggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onChange}
      className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${
        disabled
          ? "cursor-not-allowed bg-zinc-700 opacity-40"
          : on
            ? "bg-emerald-600"
            : "bg-zinc-700"
      }`}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

// ── Main component ─────────────────────────────────────────

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [totalLessons, setTotalLessons] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    const [s, l] = await Promise.all([api.getSettings(), api.listLessons(0, 20)]);
    setSettings(s);
    setLessons(l.lessons);
    setTotalLessons(l.total);
  };

  useEffect(() => {
    load().catch(console.error);
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await api.updateSettings({
        rescue_enabled: settings.rescue_enabled,
        rescue_model: settings.rescue_model,
        rescue_on_cancel: settings.rescue_on_cancel,
      });
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const downloadExport = async (onlyRescued: boolean) => {
    const blob = await api.exportTrainingData(onlyRescued);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tickle-training-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteLesson = async (id: number) => {
    await api.deleteLesson(id);
    await load();
  };

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-500">
        Loading…
      </div>
    );
  }

  const disabled = !settings.api_key_configured;
  const cancelDisabled = disabled || !settings.rescue_enabled;

  return (
    <div className="space-y-6 p-6 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Settings</h2>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
          ✕
        </button>
      </div>

      {/* ── Claude Rescue ────────────────────────────── */}
      <section>
        <SectionHeader title="Claude Rescue" />
        <div className="space-y-2">
          <Row
            title="API Key"
            description={
              settings.api_key_configured ? (
                <span className="text-emerald-400">✓ Configured</span>
              ) : (
                <>
                  <span className="text-red-400">✗ Not set</span>
                  {" — add "}
                  <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px]">
                    ANTHROPIC_API_KEY
                  </code>
                  {" env var and restart server"}
                </>
              )
            }
          />

          <Row
            title="Rescue enabled"
            description="When a block fails, Claude steps in and tries to recover."
            control={
              <Toggle
                on={settings.rescue_enabled}
                disabled={disabled}
                onChange={() =>
                  setSettings((s) => s && { ...s, rescue_enabled: !s.rescue_enabled })
                }
              />
            }
          />

          <Row
            title="Rescue on cancel"
            description="Pressing Cancel hands off to Claude from the current browser state instead of stopping the run. Captures stuck-but-not-failed cases as training data."
            control={
              <Toggle
                on={settings.rescue_on_cancel}
                disabled={cancelDisabled}
                onChange={() =>
                  setSettings((s) => s && { ...s, rescue_on_cancel: !s.rescue_on_cancel })
                }
              />
            }
          />

          <Card>
            <div className="font-medium text-zinc-200">Rescue model</div>
            <div className="mt-2 space-y-1">
              {MODELS.map((m) => (
                <label
                  key={m.value}
                  className={`flex items-center gap-3 rounded px-2 py-1.5 transition-colors ${
                    disabled
                      ? "cursor-not-allowed opacity-40"
                      : "cursor-pointer hover:bg-zinc-800"
                  }`}
                >
                  <input
                    type="radio"
                    name="rescue_model"
                    value={m.value}
                    checked={settings.rescue_model === m.value}
                    disabled={disabled}
                    onChange={() =>
                      setSettings((s) => s && { ...s, rescue_model: m.value })
                    }
                    className="accent-emerald-500"
                  />
                  <span className="flex-1 font-medium text-zinc-200">{m.label}</span>
                  <span className="text-xs text-zinc-500">{m.cost}</span>
                </label>
              ))}
            </div>
          </Card>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-zinc-700 px-4 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="text-xs text-emerald-400">Saved</span>}
        </div>
      </section>

      {/* ── Learned Lessons ──────────────────────────── */}
      <section>
        <SectionHeader
          title="Learned Lessons"
          right={
            <span className="text-xs text-zinc-500">
              {totalLessons} lesson{totalLessons !== 1 ? "s" : ""}
            </span>
          }
        />
        {lessons.length === 0 ? (
          <div className="rounded-md border border-zinc-800 px-4 py-6 text-center text-xs text-zinc-500">
            No lessons yet — they appear here after Claude rescues a failed block
          </div>
        ) : (
          <div className="space-y-1.5">
            {lessons.map((l) => (
              <div
                key={l.id}
                className="group flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2"
              >
                <span className="mt-0.5 text-xs text-zinc-500">•</span>
                <span className="flex-1 text-xs leading-relaxed text-zinc-300">{l.lesson}</span>
                <button
                  onClick={() => deleteLesson(l.id)}
                  className="hidden text-xs text-zinc-600 hover:text-red-400 group-hover:inline"
                  title="Delete lesson"
                >
                  ✕
                </button>
              </div>
            ))}
            {totalLessons > lessons.length && (
              <div className="text-center text-xs text-zinc-500">
                Showing {lessons.length} of {totalLessons}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Training Data Export ─────────────────────── */}
      <section>
        <SectionHeader title="Training Data Export" />
        <p className="mb-3 text-xs leading-relaxed text-zinc-500">
          JSONL with chosen/rejected pairs per rescue. Load into axolotl, LLaMA-Factory, or
          unsloth for DPO fine-tuning.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => downloadExport(false)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Download all runs
          </button>
          <button
            onClick={() => downloadExport(true)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Rescues only
          </button>
        </div>
      </section>
    </div>
  );
}
