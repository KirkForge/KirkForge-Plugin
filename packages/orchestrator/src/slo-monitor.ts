import type { MemoryStore } from "@55ndeep/memory-palace";

// ---------------------------------------------------------------------------
// SLO Definitions
// ---------------------------------------------------------------------------

export interface SloTarget {
  /** Metric name. */
  name: string;
  /** Target value (0–1 for rate, or absolute count). */
  target: number;
  /** Evaluation window in milliseconds. */
  windowMs: number;
}

export interface SloWindow {
  name: string;
  windowMs: number;
  total: number;
  good: number;
  bad: number;
  /** Current compliance rate (good / max(1, total)). */
  rate: number;
  /** Remaining error budget (total * target - bad) / max(1, total). */
  budgetRemaining: number;
  /** Budget consumed fraction (bad / (total * (1 - target))). */
  budgetConsumed: number;
  burnRate: number;
  status: "ok" | "warning" | "critical";
}

export interface SloReport {
  targets: SloTarget[];
  windows: SloWindow[];
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Default SLOs
// ---------------------------------------------------------------------------

export const DEFAULT_SLO_TARGETS: SloTarget[] = [
  { name: "task_pass_rate", target: 0.95, windowMs: 7 * 24 * 3600 * 1000 }, // 95% over 7d
  { name: "task_pass_rate", target: 0.99, windowMs: 30 * 24 * 3600 * 1000 }, // 99% over 30d
];

// Evaluation windows for burn-rate alerting
// "Google SRE workbook" style: error budget consumed over short & long windows
const BURN_RATE_WINDOWS = [
  { name: "1h", ms: 1 * 3600 * 1000, critical: 14.4, warning: 10 },
  { name: "6h", ms: 6 * 3600 * 1000, critical: 6.0, warning: 3 },
  { name: "24h", ms: 24 * 3600 * 1000, critical: 3.0, warning: 1 },
];

const MIN_SAMPLES = 3; // require at least 3 observations before reporting

// ---------------------------------------------------------------------------
// SloMonitor
// ---------------------------------------------------------------------------

export class SloMonitor {
  private store: MemoryStore;
  private targets: SloTarget[];

  constructor(store: MemoryStore, targets: SloTarget[] = DEFAULT_SLO_TARGETS) {
    this.store = store;
    this.targets = targets;
  }

  /**
   * Compute full SLO report from stored task observations.
   */
  async compute(): Promise<SloReport> {
    const now = Date.now();
    const windows: SloWindow[] = [];

    for (const target of this.targets) {
      for (const bw of BURN_RATE_WINDOWS) {
        // Only compute burn rate windows that fit within the target window
        if (bw.ms > target.windowMs) continue;

        const window = await this._computeWindow(target, bw.ms, now);
        if (window) windows.push(window);
      }
    }

    return { targets: this.targets, windows, computedAt: new Date().toISOString() };
  }

  private async _computeWindow(
    target: SloTarget,
    windowMs: number,
    now: number,
  ): Promise<SloWindow | null> {
    const since = new Date(now - windowMs).toISOString();
    const result = await this.store.adapter.query({
      kind: "task-observation",
      since,
      limit: 10000,
    });
    if (!result.ok || !result.value) return null;
    const observations = result.value;
    if (observations.length < MIN_SAMPLES) return null;

    let good = 0;
    let bad = 0;
    let _totalSeconds = 0;

    for (const obs of observations) {
      _totalSeconds += Number(obs.properties.durationMs ?? 0) / 1000;
      const outcome = obs.properties.outcome;
      if (outcome === "pass") {
        good++;
      } else {
        bad++;
      }
    }

    const total = good + bad;
    const rate = total > 0 ? good / total : 1;
    const budgetRemaining = target.target - (1 - rate);
    const budgetConsumed =
      target.target > 0 && 1 - target.target > 0
        ? Math.min(1, (1 - rate) / (1 - target.target))
        : 0;

    // Burn rate: how fast we're consuming error budget
    // burnRate = (bad / total) / (1 - target) * (targetWindowMs / windowMs)
    const burnRate =
      1 - target.target > 0 && windowMs > 0
        ? ((1 - rate) / (1 - target.target)) * (target.windowMs / windowMs)
        : 0;

    let status: SloWindow["status"] = "ok";
    const burnWindow = BURN_RATE_WINDOWS.find((w) => w.ms === windowMs);
    if (burnWindow && burnRate >= burnWindow.critical) {
      status = "critical";
    } else if (burnWindow && burnRate >= burnWindow.warning) {
      status = "warning";
    }

    return {
      name: `${target.name}@${this._formatWindow(windowMs)}`,
      windowMs,
      total,
      good,
      bad,
      rate: Math.round(rate * 10000) / 10000,
      budgetRemaining: Math.round(budgetRemaining * 10000) / 10000,
      budgetConsumed: Math.round(budgetConsumed * 10000) / 10000,
      burnRate: Math.round(burnRate * 100) / 100,
      status,
    };
  }

  private _formatWindow(ms: number): string {
    const h = ms / 3600000;
    return h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  }
}
