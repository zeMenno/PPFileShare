// Keep the screen on while transfers run, so phones don't pause the tab.

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire() {
  if (sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => (sentinel = null));
  } catch {
    sentinel = null; // denied or unsupported (e.g. battery saver)
  }
}

export function keepAwake(on: boolean) {
  wanted = on;
  if (on) acquire();
  else {
    sentinel?.release().catch(() => {});
    sentinel = null;
  }
}

export const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

if (typeof document !== 'undefined') {
  // The lock is dropped whenever the tab is hidden; take it back when it returns.
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible') acquire();
  });
}
