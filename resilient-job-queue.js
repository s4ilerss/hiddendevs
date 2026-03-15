"use strict";

/**
 * Resilient Job Queue — intermediate example
 *
 * A bounded-concurrency task runner where jobs are executed in parallel up
 * to a configurable limit. "Resilient" means a failing job never stops the
 * rest of the batch — its error is captured and the queue carries on.
 *
 * Core concepts illustrated:
 *
 *  1. Bounded parallelism — only `maxParallel` jobs run at the same time.
 *     This prevents resource exhaustion (open file handles, DB connections,
 *     API rate limits) when a large number of tasks are enqueued at once.
 *
 *  2. Failure isolation — when a job throws, the error is caught, stored as
 *     a "failed" result, and the worker immediately picks up the next job.
 *     One bad task cannot crash or stall the whole batch.
 *
 *  3. Complete audit trail — every job, whether successful or failed,
 *     produces a result entry recording its status, elapsed time, and either
 *     the success message or the error text. The caller always gets the full
 *     picture after `runAll()` settles.
 *
 * Architecture — shared-queue worker pool:
 *   `runAll()` spawns exactly `maxParallel` worker coroutines. All workers
 *   share the same `pendingJobs` array and race to `shift()` the next item.
 *   Because JavaScript is single-threaded, two workers can never claim the
 *   same job. When the array is empty every worker exits naturally, and
 *   `Promise.all()` resolves once the last one does.
 */
class SimpleJobQueue {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxParallel=2] - Maximum jobs that may run
   *   concurrently. Set to 1 for strictly sequential (one-at-a-time) execution.
   */
  constructor(options = {}) {
    // Clamp to at least 1 so the queue can never be permanently blocked.
    this.maxParallel = Math.max(1, options.maxParallel ?? 2);
    // FIFO ordering ensures jobs execute in the order they were enqueued,
    // which makes the execution sequence predictable and easy to reason about.
    this.pendingJobs = [];
    // Results are populated during runAll() and reset at the start of each
    // call so repeated invocations don't accumulate stale entries.
    this.results = [];
    // Auto-incrementing counter gives every job a stable, unique numeric id
    // regardless of how many times addJob() or runAll() are called.
    this.nextId = 1;
  }

  /**
   * Enqueue a job that will run when a worker slot becomes free.
   * Returns the numeric id assigned to this job, which can be used to
   * correlate the final result entry back to this `addJob` call.
   *
   * @param {string}  name        - Human-readable label used in logs and results.
   * @param {number}  durationMs  - Simulated async work time in milliseconds.
   * @param {boolean} [shouldFail=false] - When true, the job throws on purpose
   *   so the demo can show failure isolation in action.
   * @returns {number} The job's assigned id.
   */
  addJob(name, durationMs, shouldFail = false) {
    if (!name || typeof name !== "string") {
      throw new Error("Job name must be a non-empty string");
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("durationMs must be a non-negative finite number");
    }

    // Keep the descriptor plain and serialisable — no functions or complex
    // objects — so it would be straightforward to persist or transmit if needed.
    const job = {
      id: this.nextId,
      name,
      durationMs,
      shouldFail
    };

    this.nextId += 1;
    this.pendingJobs.push(job);
    return job.id;
  }

  /**
   * Execute all enqueued jobs with bounded concurrency, then resolve with
   * the complete results array once every worker has finished.
   *
   * `runAll()` can be called again after it settles — it will process
   * whatever jobs are in `pendingJobs` at that point, starting fresh.
   *
   * @returns {Promise<Array<{jobId, name, status, durationMs, details}>>}
   */
  async runAll() {
    // Reset results so each runAll() call returns a clean, self-contained report.
    this.results = [];
    const workers = [];

    // Spawn exactly maxParallel workers upfront. They all pull from the same
    // pendingJobs array, so we never need to wake or reschedule them manually —
    // each one just loops until there is nothing left to pick up.
    for (let i = 0; i < this.maxParallel; i += 1) {
      workers.push(this.runWorker(i + 1));
    }

    // Wait for all workers to drain the queue and exit before returning.
    await Promise.all(workers);
    return this.results;
  }

  /**
   * Worker loop — repeatedly claims the next pending job and executes it.
   * Exits automatically once `pendingJobs` is empty, allowing `Promise.all`
   * to settle when every worker has returned.
   *
   * @param {number} workerId - 1-based label used only for console output.
   */
  async runWorker(workerId) {
    while (this.pendingJobs.length > 0) {
      // shift() removes and returns the first job. Because JS is single-threaded,
      // this is atomic — two workers can never claim the same item.
      const job = this.pendingJobs.shift();
      if (!job) {
        // Defensive guard: if length was > 0 but shift returned undefined
        // (shouldn't happen in JS, but safe to handle), exit the worker.
        return;
      }

      const startedAt = Date.now();
      console.log(`[Worker ${workerId}] Starting  → job ${job.id}: "${job.name}"`);

      try {
        const message = await this.executeJob(job);
        this.results.push({
          jobId: job.id,
          name: job.name,
          status: "success",
          durationMs: Date.now() - startedAt,
          details: message
        });
        console.log(`[Worker ${workerId}] Finished  ✓ job ${job.id}: "${job.name}"`);
      } catch (error) {
        // Catch the error and record it as a "failed" result instead of
        // letting it propagate and crash the worker. This is the core
        // resilience guarantee — one bad job cannot poison the whole batch.
        this.results.push({
          jobId: job.id,
          name: job.name,
          status: "failed",
          durationMs: Date.now() - startedAt,
          details: error.message
        });
        console.log(
          `[Worker ${workerId}] Failed    ✗ job ${job.id}: "${job.name}" — ${error.message}`
        );
      }
    }
  }

  /**
   * Simulate an async unit of work such as an API call, file I/O, or a
   * database query. In a production system this method would be replaced with
   * (or delegate to) the real operation. The stored `durationMs` controls how
   * long this worker slot is occupied before it can pick up the next job.
   *
   * @param {{ name: string, durationMs: number, shouldFail: boolean }} job
   * @returns {Promise<string>}
   * @throws {Error} When `job.shouldFail` is true, to exercise the failure path.
   */
  async executeJob(job) {
    // sleep() stands in for any real async operation with variable latency.
    await sleep(job.durationMs);
    if (job.shouldFail) {
      throw new Error(`Job "${job.name}" failed intentionally for demo`);
    }
    return `Job "${job.name}" completed successfully`;
  }
}

/** Promisified delay used to simulate async work duration inside executeJob. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two-phase demo that makes the queue's parallelism and resilience concrete:
 *
 * Phase 1 — maxParallel=2, six jobs including two intentional failures.
 *   Shows workers interleaving, failures being isolated, and the full
 *   result table at the end with accurate per-job durations.
 *
 * Phase 2 — maxParallel=3, same six jobs re-queued.
 *   With an extra worker the total wall-clock time drops. Comparing the
 *   elapsed times between the two phases makes the concurrency benefit
 *   immediately visible in the console output.
 *
 * A short summary at the end reports failure counts and the time saved.
 */
async function demoQueue() {
  // ── Phase 1: two workers ────────────────────────────────────────────────
  console.log("═══ Phase 1: maxParallel=2, mix of durations + two failures ═══\n");
  const queue1 = new SimpleJobQueue({ maxParallel: 2 });

  queue1.addJob("compile-assets",     500, false);
  queue1.addJob("send-welcome-email", 350, false);
  queue1.addJob("generate-report",    450, true);  // Intentional failure.
  queue1.addJob("cleanup-temp-files", 250, false);
  queue1.addJob("resize-images",      300, false);
  queue1.addJob("sync-to-s3",         400, true);  // Second intentional failure.

  const phase1Start = Date.now();
  const results1    = await queue1.runAll();
  const phase1Ms    = Date.now() - phase1Start;

  console.log(`\nPhase 1 completed in ${phase1Ms} ms`);
  console.table(results1);

  // ── Phase 2: three workers, same job set ────────────────────────────────
  console.log("\n═══ Phase 2: maxParallel=3, same jobs re-queued ═══\n");
  const queue2 = new SimpleJobQueue({ maxParallel: 3 });

  queue2.addJob("compile-assets",     500, false);
  queue2.addJob("send-welcome-email", 350, false);
  queue2.addJob("generate-report",    450, true);
  queue2.addJob("cleanup-temp-files", 250, false);
  queue2.addJob("resize-images",      300, false);
  queue2.addJob("sync-to-s3",         400, true);

  const phase2Start = Date.now();
  const results2    = await queue2.runAll();
  const phase2Ms    = Date.now() - phase2Start;

  console.log(`\nPhase 2 completed in ${phase2Ms} ms`);
  console.table(results2);

  // ── Cross-phase summary ─────────────────────────────────────────────────
  console.log("\n─── Summary ───");
  const failures1 = results1.filter((r) => r.status === "failed").length;
  const failures2 = results2.filter((r) => r.status === "failed").length;
  console.log(`Phase 1 (2 workers): ${failures1} failure(s) / ${results1.length} jobs — ${phase1Ms} ms`);
  console.log(`Phase 2 (3 workers): ${failures2} failure(s) / ${results2.length} jobs — ${phase2Ms} ms`);
  console.log(`Wall-clock time saved by adding a third worker: ~${phase1Ms - phase2Ms} ms`);
}

if (require.main === module) {
  demoQueue().catch((error) => {
    console.error("Unexpected demo error:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { SimpleJobQueue };
