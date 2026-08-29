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
