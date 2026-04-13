export interface Scheduler {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export function createScheduler(opts: { intervalMs: number; run: () => void }): Scheduler {
  let timer: NodeJS.Timeout | null = null;

  return {
    start() {
      if (timer) return;
      timer = setInterval(opts.run, opts.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return Boolean(timer);
    },
  };
}

