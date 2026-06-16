const base = process.env.TERRARIUM_DEMO_URL || 'http://127.0.0.1:5178';
const [home, api] = await Promise.all([fetch(base), fetch(`${base}/api/demo`)]);
if (!home.ok || !(await home.text()).includes('Terrarium')) throw new Error('home failed');
if (!api.ok) throw new Error('campaign API failed');
const campaign = await api.json();
if (!Array.isArray(campaign.turns)) throw new Error('campaign turns missing');
if (campaign.turns.length) {
  const imageUrl = campaign.turns.find((turn) => turn.imageUrl)?.imageUrl;
  if (imageUrl) {
    const image = await fetch(`${base}${imageUrl}`);
    if (!image.ok || !(image.headers.get('content-type') || '').startsWith('image/')) throw new Error('campaign image failed');
  }
}
console.log(JSON.stringify({ ok: true, base, turns: campaign.turns.length }));
