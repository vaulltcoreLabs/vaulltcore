# Vaulltcore

B2B AI Engineering Automation platform. This repository currently contains the Phase 1A
execution foundation: a durable, resumable job runner with the OpenCode-derived agent
engine behind a replaceable seam. See [docs/phase1a.md](docs/phase1a.md) for the full
architecture report.

## Layout

- `packages/vaulltcore-runner` — neutral `AgentRunner` contract, durable state machine,
  checkpoints, append-only event log, workspace seam, tool/policy seam.
- `packages/vaulltcore-runner-opencode` — extracted OpenCode kernel + `AgentEngine`
  adapter (model boundary, event normalization).

## Commands

```bash
npm install
npm test          # vitest, 19 tests
npm run typecheck # tsc --build
```

## Brief example

```ts
import { DurableAgentRunner, FileJobStore, ScriptEngine } from "@vaulltcore/runner"

const runner = new DurableAgentRunner({
  store: new FileJobStore(".vaulltcore"),
  engines: [new ScriptEngine([{ text: "hello" }])],
  tools: [],
  workspace: null,
})

const job = await runner.createJob({
  tenantId: "t", orgId: "o", projectId: "p",
  spec: { engine: "script", model: "m", input: "do work" },
})
const state = await runner.runJob(job.jobId) // resumes safely if the worker crashed
```

## Attribution

Minimal code extracted from [opencode](https://github.com/anomalyco/opencode) (MIT
License, Copyright (c) 2025 opencode) — see `NOTICE.md` and per-file headers.
