/**
 * Turn controller for the assistant (pure, no React, unit-checked in scripts/check-voice-logic.ts).
 *
 * - One request at a time, strictly in submission order. Nothing is dropped and nothing runs in
 *   parallel; `busy` flips synchronously, so it doubles as the old `busyRef` double-send guard.
 * - `interrupt()` while a request is in flight does NOT cancel it. When it settles it is reported
 *   with `superseded: true` (the screen shows it with a marker and doesn't speak it), and then
 *   the next queued question is sent.
 * - A result is also `superseded` if another question was queued while it was in flight.
 */
export type TurnOutcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

export type TurnHandlers<J, R> = {
  run: (job: J) => Promise<R>;
  /** Called synchronously right before `run` (e.g. to show the user's caption). */
  onStart?: (job: J) => void;
  onSettled: (job: J, outcome: TurnOutcome<R>, info: { superseded: boolean }) => void;
  /** Busy flag or queue length changed. */
  onChange?: (state: { busy: boolean; queued: J[] }) => void;
};

export type TurnController<J> = {
  submit: (job: J) => void;
  interrupt: () => void;
  readonly busy: boolean;
  readonly queued: readonly J[];
};

export function createTurnController<J, R>(getHandlers: () => TurnHandlers<J, R>): TurnController<J> {
  let running = false;
  let interrupted = false;
  const queue: J[] = [];

  const notify = () => getHandlers().onChange?.({ busy: running, queued: [...queue] });

  const pump = () => {
    if (running) return;
    const job = queue.shift();
    if (job === undefined) {
      notify();
      return;
    }
    running = true;
    interrupted = false;
    notify();
    const h = getHandlers();
    let p: Promise<R>;
    try {
      h.onStart?.(job);
      p = Promise.resolve(h.run(job));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (value): TurnOutcome<R> => ({ ok: true, value }),
      (error): TurnOutcome<R> => ({ ok: false, error }),
    ).then((outcome) => {
      const superseded = interrupted || queue.length > 0;
      running = false;
      interrupted = false;
      try {
        getHandlers().onSettled(job, outcome, { superseded });
      } finally {
        pump();
      }
    });
  };

  return {
    submit(job) {
      queue.push(job);
      if (running) notify();
      pump();
    },
    interrupt() {
      if (running) interrupted = true;
    },
    get busy() {
      return running;
    },
    get queued() {
      return queue;
    },
  };
}
