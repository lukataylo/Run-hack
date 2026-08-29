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

// Motivation mode ("motivate" toggle): a short boost roughly every ten seconds
// while running. Bucketed by run context; every line has a pre-rendered clip.
export const MOTIVATE = {
  cruise: [
    { text: 'This is the pace — own it.', clip: 'motivate-cruise-1' },
    { text: 'Smooth as it gets; keep exactly this.', clip: 'motivate-cruise-2' },
    { text: 'You make this look easy.', clip: 'motivate-cruise-3' },
    { text: 'Locked in — nothing for me to do but watch.', clip: 'motivate-cruise-4' },
  ],
  dig: [
    { text: 'Legs are arguing — you get the last word.', clip: 'motivate-dig-1' },
    { text: 'This is the part that makes you faster.', clip: 'motivate-dig-2' },
    { text: 'Stay with it; the hard minute always passes.', clip: 'motivate-dig-3' },
    { text: "You've beaten tougher patches than this one.", clip: 'motivate-dig-4' },
  ],
  finish: [
    { text: "Last stretch — spend whatever's left.", clip: 'motivate-finish-1' },
    { text: 'Almost home; hold your shape to the line.', clip: 'motivate-finish-2' },
    { text: 'Make the ending the best part.', clip: 'motivate-finish-3' },
  ],
  generic: [
    { text: "Still moving, still strong — that's the whole job.", clip: 'motivate-generic-1' },
    { text: 'One step at a time is all this ever takes.', clip: 'motivate-generic-2' },
    { text: 'Quietly getting it done — I see it.', clip: 'motivate-generic-3' },
    { text: 'Forward is winning.', clip: 'motivate-generic-4' },
  ],
};

// Per-bucket shuffled deck: deal every line once (no repeats within a cycle),
// reshuffle only when the deck is exhausted.
const motivateDecks = {};
export function pickMotivate(bucket) {
  const table = MOTIVATE[bucket];
  if (!table || !table.length) return null;
  let deck = motivateDecks[bucket];
  if (!deck || !deck.length) {
    deck = table.slice();
    // Fisher–Yates
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    motivateDecks[bucket] = deck;
  }
  return deck.pop();
}

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
