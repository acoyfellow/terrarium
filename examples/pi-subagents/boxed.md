---
name: boxed
description: Runs the task in a sealed Terrarium cloud box and returns the receipt.
runner:
  type: external-job
  provider: terrarium
  options:
    channel: pi-subagents
    proof: "npm test"
---
