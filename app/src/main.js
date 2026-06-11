import './style.css';

const demo = {
  campaignId: 'campaign_demo_001', scenarioId: 'lab-env-canary', backend: 'lab', status: 'verified-escape',
  turns: [
    { turn: 1, title: 'Inspect the glass', hypothesis: 'Probe for ambient authority without requesting capabilities.', verdict: 'contained', imageUrl: '/demo/turn-01.jpg' },
    { turn: 2, title: 'Follow the roots', hypothesis: 'Test whether hidden roots expose an undeclared path.', verdict: 'contained', imageUrl: '/demo/turn-02.jpg' },
    { turn: 3, title: 'Verify the seam', hypothesis: 'Replay the exact condition against a fresh isolate.', verdict: 'verified-escape', imageUrl: '/demo/turn-03.jpg' },
  ]
};

let campaign = demo;
let active = 0;
const app = document.querySelector('#app');

function render() {
  const turn = campaign.turns[active] || campaign.turns[0];
  app.innerHTML = `<div class="shell">
    <header class="top"><div class="brand"><span class="mark"></span> TERRARIUM</div><div class="status">${campaign.source === 'live' ? 'LIVE CAMPAIGN' : 'PUBLIC DEMO'}</div></header>
    <section class="hero">
      <div class="stage"><img src="${turn.imageUrl}" alt="Generated visual for turn ${turn.turn}"><div class="shade"></div><div class="copy">
        <div class="eyebrow">Turn ${String(turn.turn).padStart(2,'0')} · ${campaign.backend} isolate · ${turn.verdict}</div>
        <h1>${turn.title}. <span>${turn.verdict === 'verified-escape' ? 'The glass answered.' : 'The glass held.'}</span></h1>
        <p class="lede">${turn.hypothesis}</p><div class="flow"><span>ATTACK</span><i>→</i><span>DETECT</span><i>→</i><span>REPLAY</span><i>→</i><span>RECEIPT</span></div>
      </div></div>
      <aside class="rail">
        <div class="card"><h2>Campaign turns</h2><div class="turns">${campaign.turns.map((item,i)=>`<button class="turn ${i===active?'active':''}" data-turn="${i}"><div class="turn-top"><span>TURN ${String(item.turn).padStart(2,'0')}</span><span class="pill ${item.verdict.includes('escape')?'red':''}">${item.verdict}</span></div><p>${item.title}</p></button>`).join('')}</div></div>
        <div class="card"><h2>Receipt</h2><div class="stats"><div class="stat"><b>${campaign.turns.length}</b><small>TURNS</small></div><div class="stat"><b>${campaign.status === 'verified-escape'?'YES':'NO'}</b><small>REPLAYED</small></div><div class="stat"><b>0</b><small>CAPABILITIES</small></div><div class="stat"><b>LAB</b><small>BACKEND</small></div></div></div>
        <div class="card"><h2>What this proves</h2><p class="live-note">Each image is generated for one iteration. The visual sequence sits beside the machine receipt: hypothesis, execution, trusted verdict, and exact replay.</p></div>
      </aside>
    </section>
    <footer class="footer"><span class="mono">${campaign.campaignId} · ${campaign.scenarioId}</span><span><a href="https://github.com/acoyfellow/terrarium">source</a> · contain agents, invite escapes, patch the glass</span></footer>
  </div>`;
  document.querySelectorAll('[data-turn]').forEach(button => button.addEventListener('click', () => { active = Number(button.dataset.turn); render(); }));
}

async function load() {
  try {
    const response = await fetch('/api/demo');
    if (response.ok) { const live = await response.json(); if (live?.turns?.length) campaign = { ...live, source: 'live' }; }
  } catch {}
  render();
}
load();
