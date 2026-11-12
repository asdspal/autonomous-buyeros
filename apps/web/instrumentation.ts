export async function register(): Promise<void> {
  if (process.env.ENABLE_JOBS !== 'on') return;
  const globalKey = Symbol.for('buyeros.jobs.started');
  const store = globalThis as unknown as Record<symbol, boolean>;
  if (store[globalKey]) return;
  store[globalKey] = true;
  setInterval(() => {
    void import('./lib/jobs')
      .then(({ runReconcileHolds }) => runReconcileHolds())
      .catch(() => undefined);
  }, 15 * 60 * 1000).unref();
  console.log(JSON.stringify({ level: 'info', msg: 'jobs.scheduler_started', every_ms: 900000 }));
}
