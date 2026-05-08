export function StatusPill({ status }: { status: string }) {
  const cls =
    status === "running"
      ? "bg-blue-500/10 text-blue-300 border-blue-500/30"
      : status === "paused"
        ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
        : status === "done"
          ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
          : status === "error"
            ? "bg-red-500/10 text-red-300 border-red-500/30"
            : status === "cancelled"
              ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
              : "bg-zinc-500/10 text-zinc-300 border-zinc-500/30";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}
