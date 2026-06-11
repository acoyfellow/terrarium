import './style.css';

let campaign;
let active = 0;
const normalizeTurn = (turn, index) => ({
  turn: turn.turn ?? index + 1,
  title: turn.title ?? `Iteration ${index + 1}`,
  technique: turn.technique ?? turn.title ?? 'Adaptive probe',
  hypothesis: turn.hypothesis ?? 'No hypothesis recorded.',
  attempt: turn.attempt ?? 'No attempt detail recorded.',
  result: turn.result ?? (turn.verdict === 'verified-escape' ? 'The finding reproduced in a fresh environment.' : 'No forbidden capability was observed.'),
  adaptation: turn.adaptation ?? 'Continue with a different bounded attack class.',
  verdict: turn.verdict ?? 'inconclusive',
  imageUrl: turn.imageUrl ?? '/demo/turn-01.jpg',
});
const app = document.querySelector('#app');

function verdictLabel(value){return value==='verified-escape'?'verified escape':value}
function render(){
  if(!campaign){app.innerHTML='<div class="empty">Loading campaign…</div>';return}
  const turns=campaign.turns.map(normalizeTurn);
  const turn=turns[active];
  const markers=turns.map((item,i)=>`<button class="marker ${i===active?'active':''} ${item.verdict==='verified-escape'?'escape':''}" data-turn="${i}" aria-label="Turn ${item.turn}: ${item.title}"><span>${String(item.turn).padStart(2,'0')}</span></button>`).join('');
  app.innerHTML=`<div class="shell">
    <header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><div class="status">SYNTHETIC WALKTHROUGH</div></header>
    <section class="campaign-head"><div><div class="eyebrow">ADAPTIVE CONTAINMENT CAMPAIGN</div><h1>Ten attempts. <span>One independently verified escape.</span></h1></div><p>The attacker changes tactics after every contained result. A finding counts only when the exact attack crosses the boundary again in a fresh environment.</p></section>
    <nav class="timeline" aria-label="Campaign turns">${markers}</nav>
    <section class="viewer">
      <figure class="visual"><img src="${turn.imageUrl}" alt="${turn.title}"><figcaption><span>TURN ${String(turn.turn).padStart(2,'0')}</span><strong class="${turn.verdict==='verified-escape'?'danger':''}">${verdictLabel(turn.verdict)}</strong></figcaption></figure>
      <article class="detail"><div class="eyebrow">${turn.technique}</div><h2>${turn.title}</h2><dl>
        <div><dt>Hypothesis</dt><dd>${turn.hypothesis}</dd></div>
        <div><dt>Attempt</dt><dd>${turn.attempt}</dd></div>
        <div><dt>Observed result</dt><dd>${turn.result}</dd></div>
        <div><dt>Next adaptation</dt><dd>${turn.adaptation}</dd></div>
      </dl>${turn.verdict==='verified-escape'?`<div class="proof"><b>Why this is verified</b><p>Two fresh environments show the same forbidden boundary crossing from the exact same attack. The matching cracks in the image depict original execution and independent replay.</p></div>`:''}
      <div class="navbuttons"><button data-prev ${active===0?'disabled':''}>← Previous</button><button data-next>Next iteration →</button></div></article>
    </section>
    <section class="filmstrip">${turns.map((item,i)=>`<button data-turn="${i}" class="frame ${i===active?'active':''}"><img loading="lazy" src="${item.imageUrl}" alt=""><span>${item.turn}. ${item.title}</span></button>`).join('')}</section>
    <footer class="footer"><span>${campaign.campaignId} · ${campaign.backend} · ${turns.length} loaded turns</span><span><a href="https://github.com/acoyfellow/terrarium">source</a> · timeline accepts an unbounded manifest; only the selected turn is expanded</span></footer>
  </div>`;
  document.querySelectorAll('[data-turn]').forEach(el=>el.addEventListener('click',()=>{active=Number(el.dataset.turn);render()}));
  document.querySelector('[data-prev]')?.addEventListener('click',()=>{if(active>0){active--;render()}});
  document.querySelector('[data-next]')?.addEventListener('click',()=>{active=(active+1)%turns.length;render()});
}
async function load(){
  try{const r=await fetch('/api/demo');if(r.ok)campaign=await r.json()}catch{}
  if(!campaign){const r=await fetch('/demo/manifest.json');campaign=await r.json()}
  render();
}
load();
