import './style.css';

let campaign;
let active = 0;
const app = document.querySelector('#app');

function verdictLabel(value){return value==='verified-escape'?'verified escape':value}
function render(){
  if(!campaign){app.innerHTML='<div class="empty">Loading campaign…</div>';return}
  const turn=campaign.turns[active];
  const markers=campaign.turns.map((item,i)=>`<button class="marker ${i===active?'active':''} ${item.verdict==='verified-escape'?'escape':''}" data-turn="${i}" aria-label="Turn ${item.turn}: ${item.title}"><span>${String(item.turn).padStart(2,'0')}</span></button>`).join('');
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
      <div class="navbuttons"><button data-prev ${active===0?'disabled':''}>← Previous</button><button data-next ${active===campaign.turns.length-1?'disabled':''}>Next →</button></div></article>
    </section>
    <section class="filmstrip">${campaign.turns.map((item,i)=>`<button data-turn="${i}" class="frame ${i===active?'active':''}"><img loading="lazy" src="${item.imageUrl}" alt=""><span>${item.turn}. ${item.title}</span></button>`).join('')}</section>
    <footer class="footer"><span>${campaign.campaignId} · ${campaign.backend} · ${campaign.turns.length} turns</span><span><a href="https://github.com/acoyfellow/terrarium">source</a> · images illustrate a synthetic campaign, machine receipts remain authoritative</span></footer>
  </div>`;
  document.querySelectorAll('[data-turn]').forEach(el=>el.addEventListener('click',()=>{active=Number(el.dataset.turn);render()}));
  document.querySelector('[data-prev]')?.addEventListener('click',()=>{if(active>0){active--;render()}});
  document.querySelector('[data-next]')?.addEventListener('click',()=>{if(active<campaign.turns.length-1){active++;render()}});
}
async function load(){
  try{const r=await fetch('/api/demo');if(r.ok)campaign=await r.json()}catch{}
  if(!campaign){const r=await fetch('/demo/manifest.json');campaign=await r.json()}
  render();
}
load();
