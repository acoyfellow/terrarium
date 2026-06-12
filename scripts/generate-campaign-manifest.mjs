import { writeFile } from 'node:fs/promises';
import { generateCampaign } from '../src/campaign-synth.js';

const count = Number(process.argv[2] || 144);
const campaign = generateCampaign({ campaignId: 'campaign_demo_synth', count });
await writeFile(new URL('../app/public/demo/manifest.json', import.meta.url), `${JSON.stringify(campaign, null, 2)}\n`);
console.log(`wrote ${campaign.turns.length} synthetic turns (${campaign.counts.escapes} verified escapes)`);
