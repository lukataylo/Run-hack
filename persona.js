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
  // goal-run milestones (one-shot) and behind-the-pace nudges
  goalHalf: [
    { text: "Halfway there. The rhythm's yours — keep it.", clip: 'persona-goalhalf-1' },
    { text: "That's half. Nothing to fix — carry on.", clip: 'persona-goalhalf-2' },
  ],
  goalNinety: [
    { text: "Ninety percent down. Hold this to the line.", clip: 'persona-goalninety-1' },
    { text: "Nearly there. Don't sprint it — just finish it.", clip: 'persona-goalninety-2' },
  ],
  goalBehind: [
    { text: "You're drifting off the pace. Lift it a touch.", clip: 'persona-goalbehind-1' },
    { text: "Behind the clock. Quicker feet, longer road eaten.", clip: 'persona-goalbehind-2' },
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

// ---- SASSY personality (CARROT-Weather-informed, strictly opt-in) ----------
// The research rules baked in here: sass rides ON TOP of correct coaching
// (corrective cues are untouched and always sincere), it punches at effort and
// excuses never at bodies, one jab per event, ≥4 min between sassy motivation
// lines, and failure sass is the gentlest — one jab then forward-looking.
export const SASSY = {
  runStart: [
    { text: "Oh good, you showed up. I had a whole speech ready about quitters.", clip: 'sassy-runstart-1' },
    { text: "Let's go, legs. Your couch will still love you when you get back.", clip: 'sassy-runstart-2' },
    { text: 'Starting the run. Lower your expectations accordingly.', clip: 'sassy-runstart-3' },
  ],
  cruise: [
    { text: "Look at you, jogging like nobody's chasing you. Because nobody is.", clip: 'sassy-cruise-1' },
    { text: "This pace is fine. 'Fine' is also how people describe airline food.", clip: 'sassy-cruise-2' },
  ],
  dig: [
    { text: "You look terrible. Wonderful. That means it's working.", clip: 'sassy-dig-1' },
    { text: 'Your legs are lying to you. I never lie. Keep going.', clip: 'sassy-dig-2' },
  ],
  goalBehind: [
    { text: "You're behind pace. The goal isn't going to chase itself. That's your one job.", clip: 'sassy-behind-1' },
    { text: "Behind the clock. I've seen glaciers negative-split better than this.", clip: 'sassy-behind-2' },
  ],
  stopped: [
    { text: 'Interesting strategy — standing still. Bold. Wrong, but bold.', clip: 'sassy-stopped-1' },
    { text: "GPS says you've stopped. Physics says the finish line hasn't moved. Your move.", clip: 'sassy-stopped-2' },
  ],
};

let personality = 'supportive';
export function setPersonality(p) { personality = p === 'sassy' ? 'sassy' : 'supportive'; }
export function getPersonality() { return personality; }

const SASS_MOTIVATE_GAP_MS = 240000; // ≥4 min between sassy motivation lines
let lastSassAt = 0;

function drawDeck(decks, key, table) {
  let deck = decks[key];
  if (!deck || !deck.length) {
    deck = table.slice();
    for (let i = deck.length - 1; i > 0; i--) { // Fisher–Yates
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    decks[key] = deck;
  }
  return deck.pop();
}

// Per-bucket shuffled deck: deal every line once (no repeats within a cycle),
// reshuffle only when the deck is exhausted.
const motivateDecks = {};
const sassyDecks = {};
export function pickMotivate(bucket) {
  // sassy swap-in: only cruise/dig get sass, rate-limited; finish/generic stay warm
  if (personality === 'sassy' && SASSY[bucket] && Date.now() - lastSassAt >= SASS_MOTIVATE_GAP_MS) {
    lastSassAt = Date.now();
    return drawDeck(sassyDecks, bucket, SASSY[bucket]);
  }
  const table = MOTIVATE[bucket];
  if (!table || !table.length) return null;
  return drawDeck(motivateDecks, bucket, table);
}

// rotate randomly without immediate repeats
const lastIdx = {};
export function pick(event) {
  // sassy overrides for the events that have them (runStart, goalBehind,
  // stopped — the last exists only in sassy mode). Greet/praise/milestones
  // stay sincere: the tonal drop is what signals "this one's real".
  if (personality === 'sassy' && SASSY[event]) return drawDeck(sassyDecks, event, SASSY[event]);
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

// goal-run dynamic lines — spoken via bridge/TTS, no pre-rendered clip
export function goalStartLine(min) {
  return { text: `${min} minutes on the clock. Settle in — I'll keep count.` };
}

export function goalCompleteLine(actualS, goalS) {
  const s = Math.max(0, Math.round(actualS));
  const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const diff = Math.round(goalS - actualS);
  if (personality === 'sassy') {
    // failure sass is the gentlest: one jab, instantly forward-looking
    return diff >= 0
      ? { text: `Goal complete in ${mmss}. I'd say I doubted you, but we both know I did.` }
      : { text: `Distance done, ${-diff} seconds over. Tragic. Anyway — we go again, and I've already forgotten this one.` };
  }
  return diff >= 0
    ? { text: `That's the distance — ${mmss}, ${diff} seconds ahead of plan. Lovely.` }
    : { text: `Distance done in ${mmss} — ${-diff} seconds over, but done is done.` };
}

export function runEndLine(score, cueCount) {
  const s = typeof score === 'number' && isFinite(score) ? Math.round(score) : null;
  if (personality === 'sassy') {
    const scorePart = s == null ? 'Run complete.' : `Run complete. Score ${s}.`;
    return { text: `${scorePart} Go hydrate, meat-based athlete. I'll be here judging your recovery.` };
  }
  const scorePart = s == null ? 'Done.' : `Done. Score ${s}.`;
  const tail = cueCount
    ? "We'll tidy that up next time."
    : 'Clean run — nothing from me.';
  return { text: `${scorePart} ${tail}` };
}
