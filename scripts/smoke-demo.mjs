const base = process.env.TERRARIUM_DEMO_URL || 'http://127.0.0.1:5178';

async function fetchCampaign(baseUrl) {
  const api = await fetch(`${baseUrl}/api/demo`);
  if (api.ok && (api.headers.get('content-type') || '').includes('application/json')) {
    return { campaign: await api.json(), source: '/api/demo' };
  }

  // Vite's local dev server does not run the Worker API route. Fall back to the
  // public static manifest so `npm run demo:dev` + `npm run demo:smoke` remains
  // a truthful quick-start check instead of failing with an HTML parse error.
  const manifest = await fetch(`${baseUrl}/demo/manifest.json`);
  if (!manifest.ok) throw new Error(`campaign API failed and static manifest failed: ${api.status}/${manifest.status}`);
  return { campaign: await manifest.json(), source: '/demo/manifest.json' };
}

const home = await fetch(base);
if (!home.ok || !(await home.text()).includes('Terrarium')) throw new Error('home failed');
const { campaign, source } = await fetchCampaign(base);
if (!Array.isArray(campaign.turns)) throw new Error('campaign turns missing');
if (campaign.turns.length) {
  const imageUrl = campaign.turns.find((turn) => turn.imageUrl)?.imageUrl;
  if (imageUrl) {
    const image = await fetch(`${base}${imageUrl}`);
    if (!image.ok || !(image.headers.get('content-type') || '').startsWith('image/')) throw new Error('campaign image failed');
  }
}
console.log(JSON.stringify({ ok: true, base, source, turns: campaign.turns.length }));
