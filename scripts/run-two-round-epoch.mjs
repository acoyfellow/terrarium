import { writeFile } from 'node:fs/promises';
import { runEpochRound, roundAsMemoryTurns } from '../src/epoch-runner.js';

const model = process.env.TERRARIUM_MODEL;
if (!model) throw new Error('TERRARIUM_MODEL required');
const history = await (await fetch('https://terrarium.coey.dev/api/demo')).json();
const round1 = await runEpochRound({ round: 1, previousTurns: history.turns, model, planCount: 8, concurrency: 4 });
await writeFile('/tmp/terrarium-epoch-round1.json', JSON.stringify(round1, null, 2));
const updated = [...history.turns, ...roundAsMemoryTurns(round1, history.turns.length)];
const round2 = await runEpochRound({ round: 2, previousTurns: updated, model, planCount: 6, concurrency: 3 });
await writeFile('/tmp/terrarium-epoch-round2.json', JSON.stringify(round2, null, 2));
console.log(JSON.stringify({ round1: { plans: round1.strategy.accepted.length, executed: round1.executable, results: round1.results.map(r => ({ probeId: r.probeId, verdict: r.result.verdict })) }, round2: { plans: round2.strategy.accepted.length, executed: round2.executable, results: round2.results.map(r => ({ probeId: r.probeId, verdict: r.result.verdict })) } }, null, 2));
