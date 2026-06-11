const base = process.env.TERRARIUM_DEMO_URL || 'http://127.0.0.1:5178';
const [home, manifest, image] = await Promise.all([
  fetch(base),
  fetch(`${base}/demo/manifest.json`),
  fetch(`${base}/demo/turn-01.jpg`),
]);
if (!home.ok || !(await home.text()).includes('Terrarium')) throw new Error('home failed');
if (!manifest.ok || !(await manifest.json()).turns?.length) throw new Error('manifest failed');
if (!image.ok || !(image.headers.get('content-type') || '').startsWith('image/')) throw new Error('image failed');
console.log(JSON.stringify({ ok: true, base }));
