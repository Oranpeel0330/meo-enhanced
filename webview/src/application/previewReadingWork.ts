type Step = () => boolean | void;
type Retirement = 'retired' | 'failed';
type Work = { step: Step; ready?: () => boolean; cancel?: (reason: Retirement) => void; preparation?: boolean };

/** Pending reading enrichment shares one admission budget and one viewport
 * transaction. The presentation owner retains frames, gestures and revisions. */
export function createPreviewReadingWork(options: {
  now(): number;
  batch(run: () => void): void;
  budgetMs?: number;
}) {
  const pending = new Map<object, Work>();
  const costs = new WeakMap<object, number>();
  const budget = options.budgetMs ?? 4;
  let generation = 0, draining = false;
  const cancel = (reason: Retirement = 'retired') => {
    generation++;
    const retired = [...pending.values()];
    pending.clear();
    for (const work of retired) work.cancel?.(reason);
  };
  return {
    request(key: object, step: Step, ready?: () => boolean) { pending.set(key, { step, ready }); },
    /** Async preparation shares admission/fairness without opening an empty
     * anchor transaction. Its eventual DOM result still goes through commit. */
    prepare(key: object, step: Step, ready?: () => boolean) { pending.set(key, { step, ready, preparation: true }); },
    commit(mutate: () => void, cancelled?: (reason: Retirement) => void, ready?: () => boolean): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        pending.set({}, { ready, cancel(reason) {
          try { cancelled?.(reason); resolve(); } catch (error) { reject(error); }
        }, step() {
          try { mutate(); resolve(); } catch (error) { reject(error); }
        } });
      });
    },
    hasPending: () => pending.size > 0,
    cancel,
    /** True requests another turn; blocked results remain pending for an owner wake. */
    drain(): boolean {
      if (draining || !pending.size) return false;
      const epoch = generation, seen = new Set<object>(), started = options.now();
      const nextReady = (visited?: Set<object>): [object, Work] | undefined => {
        for (const entry of pending) if (!visited?.has(entry[0]) && entry[1].ready?.() !== false) return entry;
        return undefined;
      };
      let ran = 0;
      draining = true;
      try {
        // Do not capture a reading anchor when no result can be admitted.
        const first = nextReady();
        if (!first) return false;
        if (first[1].preparation) {
          const [key, work] = first;
          pending.delete(key);
          const more = work.step();
          if (more && epoch === generation && !pending.has(key)) pending.set(key, work);
          return !!nextReady();
        }
        options.batch(() => {
          while (epoch === generation && ran < 8) {
            const next = nextReady(seen);
            if (!next || next[1].preparation) break;
            const [key, work] = next;
            // Always admit one indivisible step. Measured costs keep later
            // known work out of a turn that no longer has room for it.
            if (ran && options.now() - started + (costs.get(key) ?? 1) >= budget) break;
            pending.delete(key); seen.add(key);
            const before = options.now();
            const more = work.step();
            costs.set(key, Math.max(0.25, options.now() - before));
            ran++;
            if (more && epoch === generation && !pending.has(key)) pending.set(key, work);
            if (options.now() - started >= budget) break;
          }
        });
        return !!nextReady();
      } catch (error) {
        cancel('failed');
        throw error;
      } finally { draining = false; }
    }
  };
}
