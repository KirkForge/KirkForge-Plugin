import type { Command } from "commander";
import { createBootstrap } from "../bootstrap.js";
import { startDaemon } from "../serve.js";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Start daemon with health-check HTTP server (blocks until SIGTERM)")
    .action(async () => {
      const {
        orchestrator,
        eventBus,
        shutdown: _shutdown,
        enterpriseConfig,
        policyEngine,
        auditLogger,
        logger,
      } = await createBootstrap({});
      await startDaemon({
        orchestrator,
        eventBus,
        enterpriseConfig,
        policyEngine,
        auditLogger,
        logger,
      });
    });
}
