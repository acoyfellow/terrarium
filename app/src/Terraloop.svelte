<script>
  const PUBLIC = import.meta.env.VITE_PUBLIC_SITE === '1';
  const origin = PUBLIC || typeof location === 'undefined' ? 'https://<your-team-terrarium>' : location.origin;
  const pageUrl = typeof location === 'undefined' ? '/terraloop' : `${location.origin}/terraloop`;

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
5. Load the terraloop skill and its protocol.md, read ${pageUrl},
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
    <svg viewBox="0 0 960 380" class="tl-svg tl-svg-wide" role="img" aria-labelledby="tl-t tl-d">
      <title id="tl-t">A terraloop</title>
      <desc id="tl-d">Inside a contract you approve, the agent does the work. A heartbeat wakes it when it goes idle. It may spawn Terrarium children for a reason and gets a callback with a receipt. When it thinks it is done it calls the gate, which runs the proof command. Exit 0 ends the loop; a failure sends it back to work.</desc>
      <defs>
        <marker id="tl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="tl-head" /></marker>
      </defs>

      <rect x="12" y="16" width="936" height="306" rx="18" class="tl-frame" />
      <text x="36" y="44" class="tl-frame-label">contract · goal · gate · scope · proof · you said "go"</text>

      <g class="tl-node tl-key"><rect x="390" y="84" width="180" height="96" rx="14" /><text x="480" y="128" class="tl-name">agent</text><text x="480" y="152" class="tl-who">does the work</text></g>
      <g class="tl-node"><rect x="750" y="84" width="180" height="96" rx="14" /><text x="840" y="128" class="tl-name">terrarium</text><text x="840" y="152" class="tl-who">optional children</text></g>
      <g class="tl-node tl-key"><rect x="30" y="84" width="180" height="96" rx="14" /><text x="120" y="128" class="tl-name">gate</text><text x="120" y="152" class="tl-who">tool runs the proof</text></g>
      <g class="tl-node"><rect x="390" y="222" width="180" height="76" rx="14" /><text x="480" y="258" class="tl-name">heartbeat</text><text x="480" y="280" class="tl-who">loops_task</text></g>

      <path d="M574,114 L746,114" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="660" y="104" class="tl-tag">spawn · if needed</text>
      <path d="M746,150 L574,150" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="660" y="172" class="tl-tag">callback + receipt</text>

      <path d="M386,114 L214,114" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="300" y="104" class="tl-tag">"done?"</text>
      <path d="M214,150 L386,150" class="tl-line tl-loop" marker-end="url(#tl-arrow)" />
      <text x="300" y="172" class="tl-tag tl-tag-bad">fails · keep going</text>

      <path d="M480,222 L480,184" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="470" y="208" class="tl-tag tl-end">wakes it</text>
      <path d="M570,246 C620,246 620,276 574,276" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="630" y="266" class="tl-tag tl-start">when idle</text>

      <path d="M120,180 L120,346" class="tl-line tl-done" marker-end="url(#tl-arrow)" />
      <text x="134" y="364" class="tl-tag tl-tag-ok tl-start">exit 0 · loop ends</text>
    </svg>

    <svg viewBox="0 0 340 760" class="tl-svg tl-svg-tall" role="img" aria-labelledby="tl-t2">
      <title id="tl-t2">A terraloop, top to bottom</title>
      <rect x="10" y="10" width="320" height="640" rx="18" class="tl-frame" />
      <text x="26" y="36" class="tl-frame-label">contract · you said "go"</text>

      <g class="tl-node tl-key"><rect x="70" y="60" width="200" height="84" rx="14" /><text x="170" y="98" class="tl-name">gate</text><text x="170" y="122" class="tl-who">tool runs the proof</text></g>
      <g class="tl-node tl-key"><rect x="70" y="236" width="200" height="84" rx="14" /><text x="170" y="274" class="tl-name">agent</text><text x="170" y="298" class="tl-who">does the work</text></g>
      <g class="tl-node"><rect x="70" y="412" width="200" height="84" rx="14" /><text x="170" y="450" class="tl-name">terrarium</text><text x="170" y="474" class="tl-who">optional children</text></g>
      <g class="tl-node"><rect x="70" y="552" width="200" height="72" rx="14" /><text x="170" y="586" class="tl-name">heartbeat</text><text x="170" y="608" class="tl-who">loops_task</text></g>

      <path d="M140,236 L140,148" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="132" y="196" class="tl-tag tl-end">"done?"</text>
      <path d="M200,144 L200,232" class="tl-line tl-loop" marker-end="url(#tl-arrow)" />
      <text x="208" y="196" class="tl-tag tl-tag-bad tl-start">fails</text>

      <path d="M140,320 L140,408" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="132" y="370" class="tl-tag tl-end">spawn</text>
      <path d="M200,412 L200,324" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="208" y="370" class="tl-tag tl-start">receipt</text>

      <path d="M70,588 C30,588 30,278 66,278" class="tl-line" marker-end="url(#tl-arrow)" />
      <text x="24" y="440" class="tl-tag" transform="rotate(-90 24 440)">wakes it when idle</text>

      <path d="M270,102 L316,102 L316,690" class="tl-line tl-done" marker-end="url(#tl-arrow)" />
      <text x="170" y="720" class="tl-tag tl-tag-ok">exit 0 · loop ends</text>
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
