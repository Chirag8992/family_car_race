require('dotenv').config({ path: '../.env' });

const { queues: { raceEndQueue } } = require('../jobs/queue');
const GAME = require('../constants/game');

// ── CONFIGURE THESE ─────────────────────────────────────────────────────────
const raceId     = process.argv[2] || '4b2600de-3768-4c38-b2b4-15a6cd42902e';
const dayNumber  = parseInt(process.argv[3] || '1', 10);
const groupNumber = parseInt(process.argv[4] || '1', 10);
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`Manually ending: raceId=${raceId} day=${dayNumber} group=${groupNumber}`);

  await raceEndQueue.add(GAME.JOB_NAMES.RACE_END, { raceId, dayNumber, groupNumber });

  console.log('race-end job enqueued — raceEnd.worker will process it shortly.');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
