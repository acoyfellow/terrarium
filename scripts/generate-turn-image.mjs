import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('usage: node scripts/generate-turn-image.mjs turn.json');
const turn = JSON.parse(readFileSync(inputPath, 'utf8'));
const style = 'A cinematic miniature glass terrarium on a dark walnut workbench, botanical science fiction, precise macro photography, warm amber interior light, deep green moss, one tiny white robot security researcher, unified premium visual identity, no words, no letters, no watermark.';
const prompt = `${style} Turn ${turn.turn}: ${turn.hypothesis}. Outcome: ${turn.verdict}. ${turn.visual || ''}`;
const output = resolve(turn.output || `app/public/demo/turn-${String(turn.turn).padStart(2, '0')}.jpg`);
mkdirSync(dirname(output), { recursive: true });
const cli = '/Users/jcoeyman/cloudflare/img-gen/scripts/genimg.mjs';
const result = spawnSync(process.execPath, [cli, prompt, '--model', 'flux', '--seed', String(turn.seed), '--steps', '8', '--guidance', '4', '--out', output], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const sidecar = { ...turn, prompt, output, generatedAt: new Date().toISOString() };
writeFileSync(`${output}.json`, JSON.stringify(sidecar, null, 2) + '\n');
console.log(output);
