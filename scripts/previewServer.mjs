/**
 * Stopping the preview server, correctly.
 *
 * Two harnesses spawned `vite preview` without `detached: true` and then stopped it with
 * `process.kill(-pid, 'SIGTERM')` -- a process *group* that, without `detached`, does not
 * exist. The resulting ESRCH was swallowed as "already gone", the server kept running,
 * and node would not exit while the child's stdio pipes were open. A finished sweep sat
 * wedged for two and a half hours having used one second of CPU, and every job queued
 * behind it waited too.
 *
 * So: signal the group *and* the process, then wait for the exit rather than assume it,
 * then SIGKILL what is left.
 */

/** Ask the group and the child to stop, wait, then insist. Never throws. */
export async function stopPreview(child, { graceMs = 3000 } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return 'already exited';
  const signal = (target, sig) => {
    try {
      process.kill(target, sig);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH' || error.code === 'EPERM') return false;
      throw error;
    }
  };

  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve('exited'));
  });

  if (process.platform !== 'win32') signal(-child.pid, 'SIGTERM');
  signal(child.pid, 'SIGTERM');

  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), graceMs)),
  ]);
  if (outcome === 'exited') return 'stopped on SIGTERM';

  if (process.platform !== 'win32') signal(-child.pid, 'SIGKILL');
  signal(child.pid, 'SIGKILL');
  const forced = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), graceMs)),
  ]);
  // Whatever happens, do not let an unread pipe hold this process open.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  return forced === 'exited' ? 'stopped on SIGKILL' : 'refused to die; detached and abandoned';
}
