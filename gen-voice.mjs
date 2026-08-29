// One-off build script: render the four cue strings to audio/<fault>.mp3 via
// ElevenLabs TTS. Run once, commit the mp3s - the run itself never calls an API.
//   ELEVENLABS_API_KEY=... node gen-voice.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('ELEVENLABS_API_KEY is not set. Export it and re-run:');
  console.error('  ELEVENLABS_API_KEY=sk_... node gen-voice.mjs');
  process.exit(1);
}

const VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // "Adam" (ElevenLabs premade voice)
const MODEL = 'eleven_turbo_v2_5';
const FORMAT = 'mp3_44100_64';

// The exact cue vocabulary - these strings are the contract, do not edit.
const CUES = {
  cadence:   "Quicker feet. Shorten your stride.",
  bounce:    "Too much bounce. Run softer, drive forward.",
  asymmetry: "You're favouring one side. Even it out.",
  sway:      "Your head is rocking. Eyes forward, run tall.",
  // Runway persona lines (persona.js) - static variants only; km/run-end lines
  // are dynamic and always go through the bridge/TTS.
  'persona-greet-1':    "Runway here. Pods in, and let's see what you've got.",
  'persona-greet-2':    "Runway online. Whenever you're ready.",
  'persona-greet-3':    "Runway here. Lace up — I'll do the watching.",
  'persona-runstart-1': "Let's go. Find your rhythm — I'll handle the nitpicking.",
  'persona-runstart-2': "Off we go. Relax your shoulders, I've got the rest.",
  'persona-runstart-3': "Here we go. Settle in — I'll speak up if something slips.",
  'persona-praise-1':   "That's smooth. Keep exactly this.",
  'persona-praise-2':   "Textbook. Don't change a thing.",
  'persona-praise-3':   "Quiet from me is a compliment. This is why.",
  // Motivation mode lines (persona.js MOTIVATE) - all static, all pre-rendered.
  'motivate-cruise-1':  "This is the pace — own it.",
  'motivate-cruise-2':  "Smooth as it gets; keep exactly this.",
  'motivate-cruise-3':  "You make this look easy.",
  'motivate-cruise-4':  "Locked in — nothing for me to do but watch.",
  'motivate-dig-1':     "Legs are arguing — you get the last word.",
  'motivate-dig-2':     "This is the part that makes you faster.",
  'motivate-dig-3':     "Stay with it; the hard minute always passes.",
  'motivate-dig-4':     "You've beaten tougher patches than this one.",
  'motivate-finish-1':  "Last stretch — spend whatever's left.",
  'motivate-finish-2':  "Almost home; hold your shape to the line.",
  'motivate-finish-3':  "Make the ending the best part.",
  'motivate-generic-1': "Still moving, still strong — that's the whole job.",
  'motivate-generic-2': "One step at a time is all this ever takes.",
  'motivate-generic-3': "Quietly getting it done — I see it.",
  'motivate-generic-4': "Forward is winning.",
  // sassy personality (opt-in) — CARROT-Weather-informed, PG-13, punches at effort never bodies
  'posture': "Head's dropping. Chin up, run tall.",
  // coach-screen opening roasts
  'roast-1': "Oh look who remembered they have legs.",
  'roast-2': "I've seen your last run. We have work to do.",
  'roast-3': "Ah, my favourite project. And I do mean project.",
  'roast-4': "You again. The couch filed a missing persons report.",
  'roast-5': "Your cadence called. It wants ambition.",
  'roast-6': "I coach champions. I also coach you. Balance.",
  'roast-7': "Today's forecast: sweat, with a chance of excuses.",
  'roast-8': "Blink twice if you stretched. Thought so.",
  'roast-9': "Nice shoes. Let's see if they've ever met a hill.",
  'roast-10': "Lower your expectations. Now we both start winning.",
  'sassy-runstart-1': "Oh good, you showed up. I had a whole speech ready about quitters.",
  'sassy-runstart-2': "Let's go, legs. Your couch will still love you when you get back.",
  'sassy-runstart-3': "Starting the run. Lower your expectations accordingly.",
  'sassy-cruise-1': "Look at you, jogging like nobody's chasing you. Because nobody is.",
  'sassy-cruise-2': "This pace is fine. 'Fine' is also how people describe airline food.",
  'sassy-dig-1': "You look terrible. Wonderful. That means it's working.",
  'sassy-dig-2': "Your legs are lying to you. I never lie. Keep going.",
  'sassy-behind-1': "You're behind pace. The goal isn't going to chase itself. That's your one job.",
  'sassy-behind-2': "Behind the clock. I've seen glaciers negative-split better than this.",
  'sassy-stopped-1': "Interesting strategy — standing still. Bold. Wrong, but bold.",
  'sassy-stopped-2': "GPS says you've stopped. Physics says the finish line hasn't moved. Your move.",
  // Goal-run lines (persona.js) - static milestone/behind variants; the start
  // and complete lines are dynamic and always go through the bridge/TTS.
  'persona-goalhalf-1':   "Halfway there. The rhythm's yours — keep it.",
  'persona-goalhalf-2':   "That's half. Nothing to fix — carry on.",
  'persona-goalninety-1': "Ninety percent down. Hold this to the line.",
  'persona-goalninety-2': "Nearly there. Don't sprint it — just finish it.",
  'persona-goalbehind-1': "You're drifting off the pace. Lift it a touch.",
  'persona-goalbehind-2': "Behind the clock. Quicker feet, longer road eaten.",
};

await mkdir('audio', { recursive: true });

for (const [fault, text] of Object.entries(CUES)) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${FORMAT}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: MODEL }),
    }
  );
  if (!res.ok) {
    console.error(`FAIL ${fault}: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(`audio/${fault}.mp3`, buf);
  console.log(`audio/${fault}.mp3  ${(buf.length / 1024).toFixed(1)} KB  "${text}"`);
}
console.log('Done. Commit the audio/ directory.');
