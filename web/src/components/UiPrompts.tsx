import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Replacement for `window.alert` / `window.confirm`.
 *
 * Why: native dialogs block the entire page, ignore your CSS, and give
 * users no useful affordance (no "Don't ask again", no
 * styled-as-destructive-action button, no auto-dismiss for non-fatal
 * errors). Tickle's run lifecycle is fast-moving — a stuck modal
 * mid-run is friction we don't need.
 *
 *   const { toast, confirm } = useUiPrompts();
 *   toast.error("Could not delete: " + err.message);
 *   if (await confirm("Delete run #5?")) doDelete();
 */

type ToastKind = "error" | "info" | "success";

type ToastMsg = { id: string; kind: ToastKind; message: string };

type ConfirmRequest = {
  id: string;
  message: string;
  destructive: boolean;
  resolve: (ok: boolean) => void;
};

type UiPromptsApi = {
  toast: {
    error: (message: string) => void;
    info: (message: string) => void;
    success: (message: string) => void;
  };
  /** Returns a promise that resolves to true (confirmed) or false (cancelled). */
  confirm: (message: string, opts?: { destructive?: boolean }) => Promise<boolean>;
};

const Ctx = createContext<UiPromptsApi | null>(null);

function freshId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const TOAST_LIFETIME_MS = 5000;

export function UiPromptsProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [pending, setPending] = useState<ConfirmRequest | null>(null);

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = freshId();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, TOAST_LIFETIME_MS);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const confirmFn = useCallback(
    (message: string, opts?: { destructive?: boolean }) =>
      new Promise<boolean>((resolve) => {
        setPending({
          id: freshId(),
          message,
          destructive: opts?.destructive ?? false,
          resolve,
        });
      }),
    [],
  );

  const resolvePending = (ok: boolean) => {
    if (pending) {
      pending.resolve(ok);
      setPending(null);
    }
  };

  // ESC = cancel, Enter = confirm. Native dialogs offer this for free;
  // we have to wire it up.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolvePending(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        resolvePending(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
    // resolvePending is stable for one pending; not memoised on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const api: UiPromptsApi = {
    toast: {
      error: (m) => pushToast("error", m),
      info: (m) => pushToast("info", m),
      success: (m) => pushToast("success", m),
    },
    confirm: confirmFn,
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {pending && (
        <ConfirmDialog
          message={pending.message}
          destructive={pending.destructive}
          onResolve={resolvePending}
        />
      )}
    </Ctx.Provider>
  );
}

export function useUiPrompts(): UiPromptsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUiPrompts must be used inside <UiPromptsProvider>");
  return ctx;
}

// ── Presentation ────────────────────────────────────────────

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMsg[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastMsg; onDismiss: () => void }) {
  const cls =
    toast.kind === "error"
      ? "border-red-500/50 bg-red-500/10 text-red-100"
      : toast.kind === "success"
        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-100"
        : "border-zinc-700 bg-zinc-900/95 text-zinc-100";
  return (
    <div
      role="status"
      className={`pointer-events-auto flex max-w-md items-start gap-3 rounded-md border px-3 py-2 text-sm shadow-lg backdrop-blur ${cls}`}
    >
      <div className="flex-1 break-words">{toast.message}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="-m-1 shrink-0 rounded p-1 text-xs text-zinc-400 hover:text-zinc-200"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function ConfirmDialog({
  message,
  destructive,
  onResolve,
}: {
  message: string;
  destructive: boolean;
  onResolve: (ok: boolean) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => onResolve(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="max-w-md rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm text-zinc-100">{message}</div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => onResolve(true)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              destructive
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-violet-600 text-white hover:bg-violet-500"
            }`}
          >
            {destructive ? "Delete" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
