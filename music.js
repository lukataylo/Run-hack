// Adaptive music engine. MVP STUB: full five-layer Tone.js engine lands next;
// the API contract is final so callers can wire it now. All methods are safe
// no-ops until start() is called (and, in the stub, after it too).

export function create(opts = {}) {
  let running = false;
  return {
    async start() { running = true; },
    stop() { running = false; },
    update(metrics) { /* metrics may be partial or missing; tolerate both */ },
    onCue() { /* duck + sting when the engine lands */ },
    duck(db = -8, holdS = 1.5) { /* shared master-gain duck for the voice path */ },
    get running() { return running; },
  };
}

// Convenience singleton so `if (window.music) music.start()` style guards work.
let inst = null;
function ensure() { return (inst ??= create()); }
export const start = () => ensure().start();
export const stop = () => ensure().stop();
export const update = m => ensure().update(m);
export const onCue = () => ensure().onCue();
