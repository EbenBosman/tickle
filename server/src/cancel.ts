type CancelFn = () => void;

const cancellations = new Map<number, CancelFn>();

export function registerCancel(runId: number, fn: CancelFn): void {
  cancellations.set(runId, fn);
}

export function requestCancel(runId: number): boolean {
  const fn = cancellations.get(runId);
  if (!fn) return false;
  fn();
  return true;
}

export function clearCancel(runId: number): void {
  cancellations.delete(runId);
}
