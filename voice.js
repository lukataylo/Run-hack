// Audio out. Priority: pre-rendered clip (audio/<fault>.mp3) -> native bridge
// (webkit.messageHandlers.say) -> speechSynthesis. Clips are preloaded lazily
// and 404s are swallowed - the chain must work with no audio/ files at all.

const clips = {};       // fault -> Audio (only once confirmed playable)
const tried = {};       // fault -> true once we've attempted a preload
let unlocked = false;
let voice = null;       // chosen speechSynthesis voice
let currentClip = null; // last Audio element say() started (busy while playing)
let bridgeUntil = 0;    // native bridge has no completion callback — assume busy until this wall-clock time

const FAULTS = ['cadence', 'bounce', 'asymmetry', 'sway'];

function preload(fault) {
  if (tried[fault]) return;
  tried[fault] = true;
  const a = new Audio(`audio/${fault}.mp3`);
  a.preload = 'auto';
  // only trust the clip once the browser says it can play; a 404 fires error
  a.addEventListener('canplaythrough', () => { clips[fault] = a; }, { once: true });
  a.addEventListener('error', () => {}, { once: true }); // silent - fallback chain covers it
  a.load();
}

function pickVoice() {
  if (voice || !('speechSynthesis' in window)) return;
  const all = speechSynthesis.getVoices();
  if (!all.length) return; // list often arrives async; retried on each say()
  voice =
    all.find(v => v.lang === 'en-US' && v.localService) ||
    all.find(v => v.lang.startsWith('en') && v.localService) ||
    all.find(v => v.lang.startsWith('en')) ||
    all[0];
}

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

// Must be called from inside a user gesture handler (the Start tap):
// iOS unlocks both Audio-element playback and speechSynthesis per gesture.
export function unlock() {
  if (unlocked) return;
  unlocked = true;
  FAULTS.forEach(preload);
  // iOS Safari: the ring/silent switch mutes WebAudio/TTS unless the page opts
  // into the 'playback' audio session category
  try { navigator.audioSession.type = 'playback'; } catch { /* not iOS Safari */ }
  try {
    const a = new Audio(
      // 1-frame silent mp3, inline so unlock needs no network
      'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    );
    a.muted = true;
    a.play().catch(() => {});
  } catch (e) { /* no Audio in this env */ }
  try {
    if ('speechSynthesis' in window) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(''));
      pickVoice();
    }
  } catch (e) { /* no speechSynthesis */ }
}

export function say(text, fault) {
  if (fault && !tried[fault]) preload(fault);

  // 1. pre-rendered clip
  const clip = fault && clips[fault];
  if (clip) {
    try {
      clip.currentTime = 0;
      const p = clip.play();
      currentClip = clip;
      // autoplay refusal -> same fallback order as no-clip: bridge, then TTS
      if (p && p.catch) p.catch(() => bridgeOrSpeak(text));
      return;
    } catch (e) { /* fall through */ }
  }

  // 2. dynamic line: server-side ElevenLabs render (cached there), so km
  // counts and goal summaries get the real Runway voice when online. Tight
  // timeout — a dead spot must never delay the line past usefulness.
  if (!fault && unlocked && navigator.onLine !== false) {
    bridgeUntil = Date.now() + 2500; // hold isBusy() while we fetch
    fetch(`/tts?text=${encodeURIComponent(text.slice(0, 200))}`, { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => {
        const a = new Audio(URL.createObjectURL(b));
        currentClip = a;
        bridgeUntil = 0;
        return a.play();
      })
      .catch(() => { bridgeUntil = 0; bridgeOrSpeak(text); });
    return;
  }

  bridgeOrSpeak(text);
}

function bridgeOrSpeak(text) {
  // native bridge first (survives a locked screen; the shell speaks via
  // AVSpeech), then speechSynthesis
  try {
    const h = window.webkit?.messageHandlers?.say;
    if (h) {
      h.postMessage(text);
      // the bridge is fire-and-forget: no completion callback, so assume busy
      // for a fixed spell. 2500 ms is a calibration knob (~one short line).
      bridgeUntil = Date.now() + 2500;
      return;
    }
  } catch (e) { /* fall through */ }
  speak(text);
}

// Is anything audibly speaking right now? Best-effort across all three output
// paths — used to keep optional lines (motivation) from talking over a cue.
export function isBusy() {
  try {
    if (currentClip && !currentClip.paused && !currentClip.ended) return true;
  } catch { /* Audio may be gone */ }
  if (Date.now() < bridgeUntil) return true;
  try {
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking) return true;
  } catch { /* no speechSynthesis */ }
  return false;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    pickVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 1.0;
    u.lang = voice?.lang || 'en-US';
    speechSynthesis.cancel(); // a stale queued cue must never delay a fresh one
    speechSynthesis.speak(u);
  } catch (e) { /* audio is best-effort; never take the app down */ }
}
