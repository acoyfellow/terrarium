<script>
  let { autoplay = true, intervalMs = 7000, compact = false } = $props();

  const slides = [
    {
      id: 'pain',
      kicker: 'The pain',
      title: 'It said it was done.',
      body: 'An agent reports success. You check, and it isn\u2019t true. It wasn\u2019t your prompt: by default the agent grades its own work.',
    },
    {
      id: 'cost',
      kicker: 'The real cost',
      title: 'Checking is the bottleneck.',
      body: 'Starting agents is cheap. Trusting them is not. So we run one, watch it, and stop there.',
    },
    {
      id: 'run',
      kicker: 'How a run works',
      title: 'A sealed box, a one-time code.',
      body: 'Each task runs in a Cloudflare container with no internet. The server hands out a one-time code, and the answer only counts if it comes back with it.',
    },
    {
      id: 'loop',
      kicker: 'How a loop works',
      title: 'The agent can\u2019t call itself done.',
      body: 'You lock a goal and a proof command. The agent works; a heartbeat keeps it going. Only the tool, by running your proof, can end the loop.',
    },
    {
      id: 'proof',
      kicker: 'Measured',
      title: 'Receipts, not claims.',
      body: 'Live checks on the team instance, with the receipt files in the repo.',
    },
    {
      id: 'honest',
      kicker: 'What it doesn\u2019t do',
      title: 'Provenance isn\u2019t correctness.',
      body: 'Provenance proves which run answered. A made-up answer still has it. So runs and loops take a proof command that Terrarium runs itself, and a false claim fails.',
    },
  ];

  const stats = [
    ['403', 'outside sites from inside the box'],
    ['0', 'secrets in the box'],
    ['~7 s', 'one task, end to end'],
    ['22 s', 'result back in Pi, unprompted'],
    ['881', 'lines of service code'],
    ['14/14', 'planted bugs caught by tests'],
  ];

  let index = $state(0);
  let paused = $state(false);
  let root;

  const go = (next) => { index = (next + slides.length) % slides.length; };
  const current = $derived(slides[index]);

  $effect(() => {
    if (!autoplay || paused) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const timer = setInterval(() => go(index + 1), intervalMs);
    return () => clearInterval(timer);
  });

  function onKey(event) {
    if (event.key === 'ArrowRight') { go(index + 1); paused = true; }
    if (event.key === 'ArrowLeft') { go(index - 1); paused = true; }
  }
</script>

<div class="ex" class:ex-compact={compact} bind:this={root} role="region" aria-roledescription="carousel" aria-label="What Terrarium is" tabindex="0"
  onkeydown={onKey} onmouseenter={() => { paused = true; }} onmouseleave={() => { paused = false; }} onfocusin={() => { paused = true; }}>
  <div class="ex-stage" aria-live="polite">
    {#key current.id}
      <div class="ex-slide">
        <div class="ex-visual" aria-hidden="true">
          {#if current.id === 'pain'}
            <div class="ex-chat"><span class="ex-bubble">✅ All tests pass. Deployed.</span><code class="ex-term">$ curl /api/new → <b class="ex-bad">404</b></code></div>
          {:else if current.id === 'cost'}
            <div class="ex-row"><span class="ex-chip">agent</span><span class="ex-arrow">→</span><span class="ex-chip ex-chip-warn">you, watching</span><span class="ex-arrow">→</span><span class="ex-chip">⏱</span></div>
          {:else if current.id === 'run'}
            <svg viewBox="0 0 320 120" class="ex-svg">
              <rect x="6" y="34" width="80" height="52" rx="10" class="ex-n" /><text x="46" y="65">agent</text>
              <rect x="120" y="14" width="120" height="92" rx="12" class="ex-box" /><text x="180" y="44">box</text><text x="180" y="64" class="ex-s">no internet</text><text x="180" y="82" class="ex-s">code: 7f3a…</text>
              <rect x="262" y="34" width="52" height="52" rx="10" class="ex-n" /><text x="288" y="65">AI</text>
              <path d="M86,60 L118,60" class="ex-l" /><path d="M240,60 L260,60" class="ex-l ex-okl" />
              <path d="M240,24 L276,8" class="ex-l ex-x" /><text x="292" y="12" class="ex-s ex-blocked">403</text>
            </svg>
          {:else if current.id === 'loop'}
            <svg viewBox="0 0 320 120" class="ex-svg">
              <rect x="4" y="4" width="312" height="112" rx="14" class="ex-frame" />
              <rect x="20" y="36" width="80" height="48" rx="10" class="ex-n ex-key" /><text x="60" y="65">gate</text>
              <rect x="140" y="36" width="80" height="48" rx="10" class="ex-n ex-key" /><text x="180" y="65">agent</text>
              <rect x="236" y="36" width="70" height="48" rx="10" class="ex-n" /><text x="271" y="65" class="ex-s2">heartbeat</text>
              <path d="M140,52 L102,52" class="ex-l" /><path d="M102,70 L140,70" class="ex-l ex-warn" /><path d="M236,60 L222,60" class="ex-l" />
            </svg>
          {:else if current.id === 'proof'}
            <div class="ex-stats">{#each stats as [n, label]}<div><b>{n}</b><span>{label}</span></div>{/each}</div>
          {:else}
            <div class="ex-chat"><span class="ex-bubble">provenance: this-run</span><code class="ex-term">claim: all tests pass · proof: <b class="ex-bad">exit 1</b> → failed</code></div>
          {/if}
        </div>
        <div class="ex-copy">
          <span class="ex-kicker">{index + 1} / {slides.length} · {current.kicker}</span>
          <h3>{current.title}</h3>
          <p>{current.body}</p>
        </div>
      </div>
    {/key}
  </div>

  <div class="ex-controls">
    <button class="ex-btn" aria-label="Previous" onclick={() => { go(index - 1); paused = true; }}>←</button>
    <div class="ex-dots" role="tablist">
      {#each slides as slide, i}
        <button role="tab" aria-selected={i === index} aria-label={slide.kicker} class="ex-dot" class:on={i === index} onclick={() => { go(i); paused = true; }}>
          {#if i === index && autoplay && !paused}<span class="ex-fill" style:animation-duration={`${intervalMs}ms`}></span>{/if}
        </button>
      {/each}
    </div>
    <button class="ex-btn" aria-label="Next" onclick={() => { go(index + 1); paused = true; }}>→</button>
  </div>
</div>
