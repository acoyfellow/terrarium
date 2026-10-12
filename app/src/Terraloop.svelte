<script>
  const origin = typeof location === 'undefined' ? 'https://terrarium.<your-team-domain>' : location.origin;

  const repo = ['https:', '', 'github.com', 'acoyfellow', 'terrarium'].join('/');

  const oneShot = `Set me up for terraloops, then prove it works.

1. Install the Pi packages:
   pi install git:github.com/acoyfellow/terraloop-mode@main
   pi install git:github.com/acoyfellow/loops-yaml
2. Install Terrarium and sign in (opens a browser once):
   brew install cloudflared
   git clone ${repo} ~/terrarium
   cd ~/terrarium/effect && npm ci && cd .. && npm install -g .
   terra login ${origin}
3. Tell me to run /reload, then confirm these exist:
   tools: terraloop_control, loops_task, mcp__terrarium__terrarium_spawn
   skills: terraloop, terraloop-review (they ship inside terraloop-mode)
4. Prove it: run terrarium_spawn with task "Reply with exactly: ready".
   Report the runId, status and contractStatus.
5. Load the terraloop skill and its protocol.md, read ${origin}/terraloop,
   and summarize the five steps back to me.
6. Remind me: after any loop, ask for /skill:terraloop-review.`;

  const firstLoop = `Run a terraloop: <what you want done, one line>.`;

  const steps = [
    { n: '1', name: 'Arm', who: 'you or the agent', body: 'You type /terraloop, or ask for a loop and the agent calls terraloop_control action=arm with a north star. From now on the agent cannot edit files or spawn children until a contract exists.' },
    { n: '2', name: 'Contract', who: 'agent drafts, you approve', body: 'The agent writes back Goal, Gate, Scope and Proof in about five lines and waits. You reply go. It calls action=lock.' },
    { n: '3', name: 'Driver', who: 'agent', body: 'The agent creates a loops_task heartbeat. It keeps the session moving while you are away; a settle tick re-prompts it as soon as a turn ends.' },
    { n: '4', name: 'Work', who: 'agent, children', body: 'The agent works inside the locked scope. It spawns a Terrarium child only for a named reason: parallel, isolate, bound, context or proof. Writes outside the scope are blocked.' },
    { n: '5', name: 'Gate', who: 'the tool, not the agent', body: 'The agent calls action=gate. The tool runs the Proof command itself. Exit 0 ends the loop; anything else sends it back to work. The agent cannot declare itself done.' },
  ];

  const contract = [
    ['Goal', 'A falsifiable end state.', 'GET /api/loops returns the new state field for every loop.'],
    ['Gate', 'The binary condition that stops the loop.', 'The proof command exits 0 on a fresh checkout of main.'],
    ['Scope', 'Absolute paths the parent and every child may write.', '/Users/you/code/terrarium'],
    ['Proof', 'One runnable command. The tool runs it.', 'npm test && node scripts/prod-checks.mjs'],
  ];

  const levers = [
    ['Parallel', 'Two or more independent jobs at once.'],
    ['Isolate', 'A writer must not touch your working tree.'],
    ['Bound', 'Long or risky work you may cancel, with a receipt.'],
    ['Context', 'A huge read-only dig that would bloat the session.'],
    ['Proof', 'An outside fact you must not take from chat.'],
  ];

  const tools = [
    ['terraloop-mode', 'The Pi extension that enforces the protocol by blocking tool calls.', 'https://github.com/acoyfellow/terraloop-mode'],
    ['loops-yaml', 'Pi extension behind loops_task: the driver heartbeat.', 'https://github.com/acoyfellow/loops-yaml'],
    ['Terrarium', 'Runs child agents in the cloud with receipts. This site.', 'https://github.com/acoyfellow/terrarium'],
    ['Pi', 'The coding agent everything plugs into.', 'https://github.com/earendil-works/pi'],
    ['cloudflared', 'Signs you in to Terrarium through Cloudflare Access.', 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'],
  ];

  const skills = [
    ['terraloop', 'The protocol itself. The agent loads it whenever a loop is asked for or the gate is armed: how to draft the contract, when a child is allowed, how to reach the gate. Its protocol.md is the full rulebook.', '/skill:terraloop', 'https://github.com/acoyfellow/terraloop-mode/tree/main/skills/terraloop'],
    ['terraloop-review', 'An adversarial review of the loop that just ended. It asks whether the gate was the right one, whether the proof really proved it, what was missed, and whether another loop is worth it. It never starts a loop and always ends with one best next step.', '/skill:terraloop-review', 'https://github.com/acoyfellow/terraloop-mode/tree/main/skills/terraloop-review'],
  ];

  const commands = [
    ['/terraloop <north star>', 'Arm the gate.'],
    ['/terraloop-status', 'Phase, contract, overrides, settle ticks.'],
    ['/terraloop-off', 'Leave terraloop mode and stop its drivers. Only you can do this.'],
    ['/skill:terraloop-review', 'Review the loop that just ended. Run it after every loop.'],
    ['terraloop_control action=status', 'The agent checks where it is.'],
    ['terraloop_control action=override reason="…"', 'A rare exception for a path the contract missed. 20 per loop.'],
  ];

  let copied = $state('');
  async function copy(id, text) {
    await navigator.clipboard.writeText(text);
    copied = id;
    setTimeout(() => { if (copied === id) copied = ''; }, 1600);
  }
</script>

<section class="tl">
  <header class="tl-hero">
    <div class="eyebrow">Terraloop</div>
    <h1>Hand off a goal, not a chat</h1>
    <p class="lead">A terraloop is a contract your agent cannot skip. It writes down what done means, works toward it while you are away, and stops only when a command the tool runs itself says it is done.</p>
    <div class="tl-hero-actions">
      <a class="btn btn-primary" href="#start">Get started in one paste</a>
      <a class="btn" href="/loops">Open the Loops cockpit</a>
    </div>
  </header>

  <figure class="tl-figure">
    <svg viewBox="0 0 960 300" class="tl-svg tl-svg-wide" role="img" aria-labelledby="tl-t tl-d">
      <title id="tl-t">The terraloop process</title>
      <desc id="tl-d">Arm, then contract with your go, then driver, then work, then the gate. A failing proof goes back to work. Exit 0 ends the loop.</desc>
      <defs>
        <marker id="tl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="tl-head" /></marker>
      </defs>
      {#each steps as step, i}
        {@const x = 20 + i * 188}
        <g class="tl-node" class:tl-key={step.name === 'Contract' || step.name === 'Gate'}>
          <rect x={x} y="70" width="160" height="92" rx="14" />
          <text x={x + 22} y="102" class="tl-num">{step.n}</text>
          <text x={x + 80} y="124" class="tl-name">{step.name}</text>
          <text x={x + 80} y="146" class="tl-who">{step.who}</text>
        </g>
        {#if i < steps.length - 1}<path d={`M${x + 160},116 L${x + 186},116`} class="tl-line" marker-end="url(#tl-arrow)" />{/if}
      {/each}
      <text x="290" y="56" class="tl-tag">you reply "go"</text>
      <path d="M856,162 C856,240 668,240 668,166" class="tl-line tl-loop" marker-end="url(#tl-arrow)" />
      <text x="762" y="256" class="tl-tag tl-tag-bad">proof fails · keep working</text>
      <path d="M940,116 L956,116" class="tl-line" />
      <text x="856" y="56" class="tl-tag tl-tag-ok">exit 0 · done</text>
      <rect x="20" y="276" width="920" height="1" class="tl-rule" />
    </svg>

    <svg viewBox="0 0 320 640" class="tl-svg tl-svg-tall" role="img" aria-labelledby="tl-t2">
      <title id="tl-t2">The terraloop process, top to bottom</title>
      {#each steps as step, i}
        {@const y = 16 + i * 122}
        <g class="tl-node" class:tl-key={step.name === 'Contract' || step.name === 'Gate'}>
          <rect x="40" y={y} width="240" height="84" rx="14" />
          <text x="62" y={y + 32} class="tl-num">{step.n}</text>
          <text x="170" y={y + 38} class="tl-name">{step.name}</text>
          <text x="170" y={y + 60} class="tl-who">{step.who}</text>
        </g>
        {#if i < steps.length - 1}<path d={`M160,${y + 84} L160,${y + 120}`} class="tl-line" marker-end="url(#tl-arrow)" />{/if}
      {/each}
      <path d="M280,546 C316,546 316,424 280,424" class="tl-line tl-loop" marker-end="url(#tl-arrow)" />
      <text x="300" y="490" class="tl-tag tl-tag-bad" transform="rotate(90 300 490)">proof fails</text>
    </svg>
  </figure>

  <ol class="tl-steps">
    {#each steps as step}
      <li><span class="tl-step-n">{step.n}</span><div><h3>{step.name} <small>{step.who}</small></h3><p>{step.body}</p></div></li>
    {/each}
  </ol>

  <h2>The contract</h2>
  <p>Four fields, locked before any work starts. The agent drafts them; you approve with one word.</p>
  <div class="tl-contract">
    {#each contract as [field, what, example]}
      <article><h3>{field}</h3><p>{what}</p><code>{example}</code></article>
    {/each}
  </div>

  <h2>Why it holds</h2>
  <div class="tl-why">
    <article><h3>Enforced, not requested</h3><p>The rules live in Pi's tool-call hook. A skipped step is a blocked call with a reason, so the agent cannot talk its way past one.</p></article>
    <article><h3>No self-certified finish</h3><p>The tool runs the Proof command. An agent that says "done" without exit 0 is sent back to work.</p></article>
    <article><h3>Children get less, never more</h3><p>A child agent inherits the locked scope. Spawning a child to write somewhere the parent was blocked is refused.</p></article>
    <article><h3>Only you can stop it</h3><p>The agent can arm a loop but has no off switch. /terraloop-off is yours.</p></article>
  </div>

  <h2>When the agent spawns a child</h2>
  <p>The parent does the work by default. A Terrarium child needs one of these reasons, written in its task:</p>
  <ul class="tl-levers">{#each levers as [name, when]}<li><b>{name}</b>{when}</li>{/each}</ul>

  <h2 id="start">Get started in one paste</h2>
  <p>Paste this into your coding agent (Pi). It installs everything, signs you in, proves a cloud run works, and reads this page back to you.</p>
  <div class="tl-copy">
    <button class="btn btn-primary tl-copy-btn" onclick={() => copy('setup', oneShot)}>{copied === 'setup' ? 'Copied ✓' : 'Copy setup prompt'}</button>
    <pre>{oneShot}</pre>
  </div>
  <p>Then start your first loop:</p>
  <div class="tl-copy tl-copy-small">
    <button class="btn tl-copy-btn" onclick={() => copy('first', firstLoop)}>{copied === 'first' ? 'Copied ✓' : 'Copy'}</button>
    <pre>{firstLoop}</pre>
  </div>
  <p class="tl-note">Loops that run tasks on Terrarium itself show up live on the <a href="/loops">Loops cockpit</a>, and you can start, cancel and rerun them from there.</p>

  <h2>Skills</h2>
  <p>Both ship inside terraloop-mode, so the install above adds them. Use them as a pair: one to run a loop, one to question it afterwards.</p>
  <div class="tl-skills">
    {#each skills as [name, what, invoke, href]}
      <article>
        <h3><a href={href}>{name}</a></h3>
        <p>{what}</p>
        <button class="tl-invoke" onclick={() => copy(name, invoke)}><code>{invoke}</code><span>{copied === name ? 'Copied ✓' : 'Copy'}</span></button>
      </article>
    {/each}
  </div>

  <h2>Commands</h2>
  <table class="tl-table"><tbody>{#each commands as [cmd, what]}<tr><td><code>{cmd}</code></td><td>{what}</td></tr>{/each}</tbody></table>

  <h2>Tools and links</h2>
  <ul class="tl-tools">
    {#each tools as [name, what, href]}<li><a href={href}>{name}</a><span>{what}</span></li>{/each}
  </ul>
</section>
