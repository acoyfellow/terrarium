// Mistyped-subcommand guard for the terra CLI.
//
// Problem this solves (7-minute usability): the CLI dispatches known
// subcommands and otherwise falls through to running the argument as a child
// agent task. So `terra statsu` or `terra group stats <id>` silently spawns a
// real child agent to "do" the typo instead of failing fast. That burns a run,
// confuses new users, and hides the mistake.
//
// This guard recognizes a first token that is a near-miss of a known command
// and lets the CLI fail closed with a suggestion, while leaving genuine prose
// tasks ("fix the bug", "status of the migration") untouched.

// Top-level commands the CLI dispatches today. Keep in sync with src/cli.js.
export const KNOWN_COMMANDS = [
  "plan",
  "status",
  "read",
  "cancel",
  "batch",
  "group",
  "probe",
  "verify",
  "attack",
  "secure-agent",
  "secure",
  "doctor",
  "schedule",
  "hardening",
  "scenarios",
  "campaign",
  "campaigns",
  "fixture",
  "hostile",
  "heal",
  "heal-replay",
];

// Subcommands for commands that take a verb as their first argument.
export const KNOWN_SUBCOMMANDS = {
  group: ["create", "status", "read"],
  campaign: ["local", "strategize", "read", "verify", "issue-draft"],
  schedule: ["replay"],
  hardening: ["verify"],
  fixture: ["escape"],
  hostile: ["run"],
};

// Classic Levenshtein edit distance, bounded so we never scan unbounded input.
export function editDistance(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// A token "looks like a command" only if it is shaped like a flagless verb:
// short, lowercase letters/dashes, no spaces, not an option. This keeps real
// prose tasks ("Fix the login bug") from ever being treated as a command typo.
function looksLikeCommandToken(token) {
  return typeof token === "string" && /^[a-z][a-z-]{0,19}$/.test(token);
}

// Allowed edit distance scales with command length so short commands ("read",
// "heal") don't over-match unrelated words, while longer ones tolerate one slip.
function allowedDistance(command) {
  return command.length >= 6 ? 2 : 1;
}

// Find the closest known command to a token, within the allowed threshold.
// Exact matches and the empty token return null (not a typo to correct).
function closestCommand(token, commands) {
  if (!looksLikeCommandToken(token)) return null;
  if (commands.includes(token)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const command of commands) {
    const distance = editDistance(token, command);
    const threshold = allowedDistance(command);
    if (distance <= threshold && distance < bestDistance) {
      best = command;
      bestDistance = distance;
    }
  }
  return best;
}

// Inspect the parsed argv tokens and return a correction suggestion when the
// user almost certainly meant a known command/subcommand. Returns null when the
// input is a valid command or genuine task prose.
//
// tokens: positional args only (flags already parsed out by the CLI).
export function detectMistypedCommand(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const [first, second] = tokens;

  // Exact top-level command: defer to the real dispatcher, except for verbs
  // that require a subcommand. For those, a missing or unrecognized subcommand
  // must fail closed here. Otherwise the CLI dispatch chain matches none of the
  // guarded `cmd === verb && rest[0] === sub` branches and falls through to the
  // default branch, silently spawning a child agent to "run" the broken verb
  // (e.g. `terra group`, `terra schedule run f.json`). That burns a real run on
  // an obvious mistake.
  if (KNOWN_COMMANDS.includes(first)) {
    const subcommands = KNOWN_SUBCOMMANDS[first];
    if (subcommands) {
      const valid = subcommands.join(", ");
      if (second === undefined) {
        return {
          kind: "subcommand",
          command: first,
          input: null,
          suggestion: null,
          message: `"${first}" needs a subcommand: ${valid}. Run "terra --help".`,
        };
      }
      if (!subcommands.includes(second)) {
        const suggestion = closestCommand(second, subcommands);
        return {
          kind: "subcommand",
          command: first,
          input: second,
          suggestion,
          message: suggestion
            ? `unknown subcommand "${first} ${second}". Did you mean "${first} ${suggestion}"? Run "terra --help".`
            : `unknown subcommand "${first} ${second}". Valid: ${valid}. Run "terra --help".`,
        };
      }
    }
    return null;
  }

  // First token is a near-miss of a top-level command.
  const suggestion = closestCommand(first, KNOWN_COMMANDS);
  if (suggestion) {
    return {
      kind: "command",
      input: first,
      suggestion,
      message: `unknown command "${first}". Did you mean "terra ${suggestion}"? Run "terra --help", or pass --task to run it as a task.`,
    };
  }

  return null;
}
