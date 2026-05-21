# @55ndeep/plugin

Public API surface for the 55NDeep deterministic verification, correction, and routing layer.

## Install

```bash
npm install @55ndeep/plugin
```

## Usage

```ts
import { createPluginCore } from "@55ndeep/plugin";
import { MemoryStore } from "@55ndeep/memory-palace";

const memory = new MemoryStore({ backend: "memory" });
const plugin = createPluginCore({ memoryStore: memory });

// Verify a workspace
const result = await plugin.verifyWorkspace({
  workspace: "/path/to/project",
  language: "typescript",
  description: "Add user authentication",
});

if (result.ok) {
  console.log("Score:", result.value.batteryScore);
  console.log("Issues:", result.value.issues);
}

// Check tool availability
const report = await plugin.doctor();
console.log("Available tools:", report.languages);
```

## API

See the full TypeDoc-generated API reference at [docs.55ndeep.dev](https://docs.55ndeep.dev).

### `createPluginCore(config?)`

Returns `{ verifyWorkspace, buildCorrectionPrompt, recordObservation, recallRoutingBias, doctor }`.

### `verifyWorkspace(input)`

Runs the full verification pipeline (lint, types, security, changes, graph) and returns a `Result<ReducedStatePacket>`.

### `doctor()`

Probes external tools and returns a `ToolCapabilityReport`.

### `buildCorrectionPrompt(packet, context?)`

Generates a correction prompt from a verification packet.

## License

Apache-2.0
