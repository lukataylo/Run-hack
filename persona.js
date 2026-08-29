// persona.js — "Runway", the coach's voice personality. Confident, warm, a
// little dry; short lines, never chirpy, never more than one sentence-pair.
// Zero deps, pure data + pickers. The four corrective cue strings live in
// coach.js and are a frozen contract — nothing here touches them.

// Static line tables. Each entry carries a clip key so pre-rendered mp3s
// (audio/<clip>.mp3, see gen-voice.mjs) are used when present; voice.js falls
// back to bridge/TTS when they are not.
export const LINES = {
  greet: [
    { text: "Runway here. Pods in, and let's see what you've got.", clip: 'persona-greet-1' },
    { text: "Runway online. Whenever you're ready.", clip: 'persona-greet-2' },
    { text: "Runway here. Lace up — I'll do the watching.", clip: 'persona-greet-3' },
  ],
  runStart: [
    { text: "Let's go. Find your rhythm — I'll handle the nitpicking.", clip: 'persona-runstart-1' },
    { text: "Off we go. Relax your shoulders, I've got the rest.", clip: 'persona-runstart-2' },
    { text: "Here we go. Settle in — I'll speak up if something slips.", clip: 'persona-runstart-3' },
  ],
  praise: [
    { text: "That's smooth. Keep exactly this.", clip: 'persona-praise-1' },
    { text: "Textbook. Don't change a thing.", clip: 'persona-praise-2' },
    { text: "Quiet from me is a compliment. This is why.", clip: 'persona-praise-3' },
  ],
};

// rotate randomly without immediate repeats
const lastIdx = {};
export function pick(event) {
  const table = LINES[event];
  if (!table || !table.length) return null;
  if (table.length === 1) return table[0];
  let i;
  do { i = Math.floor(Math.random() * table.length); } while (i === lastIdx[event]);
  lastIdx[event] = i;
  return table[i];
}

// dynamic lines — spoken via bridge/TTS, no pre-rendered clip
export function kmLine(n) {
  if (!(n >= 1)) return null;
  const variants = [
    `That's ${n} K down. Form's holding.`,
    `${n} K in the bank. Keep it rolling.`,
    `${n} K. Right on rhythm.`,
  ];
  return { text: variants[n % variants.length] };
}

export function runEndLine(score, cueCount) {
  const s = typeof score === 'number' && isFinite(score) ? Math.round(score) : null;
  const scorePart = s == null ? 'Done.' : `Done. Score ${s}.`;
  const tail = cueCount
    ? "We'll tidy that up next time."
    : 'Clean run — nothing from me.';
  return { text: `${scorePart} ${tail}` };
}
