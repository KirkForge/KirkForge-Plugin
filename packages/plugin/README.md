# @kirkforge/plugin

Public API surface for the KirkForge deterministic verification, correction, and routing layer.

## Install

```bash
npm install @kirkforge/plugin
```

## Usage

```ts
import { createPluginCore } from "@kirkforge/plugin";
import { MemoryStore, InMemoryAdapter } from "@kirkforge/memory-palace";

const memory = new MemoryStore(new InMemoryAdapter());
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

See the full TypeDoc-generated API reference at [docs.kirkforge.dev](https://docs.kirkforge.dev).

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
