// Deterministic Terrarium child used by the shard-A evidence harness.
//
// It is NOT an LLM. It parses the Terrarium prompt handed to it as the final
// argv (which embeds the run's taskContract: runId, taskFingerprint, nonce) and
// emits exactly one valid TERRARIUM_RESULT line. This lets the harness exercise
// the *real* JS execution + receipt-validation path (spawn -> capture ->
// validateTaskContractOutput -> finishRun) with zero network, zero model cost,
// and fully reproducible timing.
//
// Behaviour is selected by TERRARIUM_FIXTURE_MODE:
//   verified  (default) emit the exact expected receipt -> status "done"
//   missing             emit no receipt line            -> status "inconclusive"
//   mismatch            emit a receipt with wrong nonce  -> status "inconclusive"
//   malformed           emit a receipt with extra key    -> status "inconclusive"
//   nonzero             emit valid receipt then exit 3   -> status "failed"
//
// The expected receipt is recovered from the prompt rather than passed
// separately, proving the contract round-trips through the real prompt builder.

const mode = process.env.TERRARIUM_FIXTURE_MODE || "verified";
const prompt = process.argv[process.argv.length - 1] || "";

// The prompt embeds the contract template:
//   TERRARIUM_RESULT={"runId":"...","taskFingerprint":"...","nonce":"...","summary":"brief task-specific result"}
const marker = "TERRARIUM_RESULT=";
const idx = prompt.indexOf(marker);
let contract = null;
if (idx !== -1) {
  const rest = prompt.slice(idx + marker.length);
  // The JSON object ends at the first balanced closing brace.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") depth++;
    else if (rest[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end !== -1) {
    try { contract = JSON.parse(rest.slice(0, end)); } catch { contract = null; }
  }
}

if (!contract) {
  // No contract found: behave like a child that ignored the contract.
  console.log("no contract detected in prompt");
  process.exit(mode === "nonzero" ? 3 : 0);
}

const summary = `shard-a fixture (${mode}) for ${contract.runId}`;

function emit(obj) {
  console.log(marker + JSON.stringify(obj));
}

switch (mode) {
  case "verified":
    emit({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce, summary });
    break;
  case "missing":
    console.log("did the work but forgot the receipt line");
    break;
  case "mismatch":
    emit({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: "00000000-0000-0000-0000-000000000000", summary });
    break;
  case "malformed":
    emit({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce, summary, extra: "not-allowed" });
    break;
  case "nonzero":
    emit({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce, summary });
    console.log("work failed after emitting receipt");
    process.exit(3);
  default:
    emit({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce, summary });
}
