"use strict";

/**
 * this is a job queue script
 * it runs tasks with a fixed parallel limit and records execution results
 * the whole point is to show clean async flow without doing anything fancy
 */
class SimpleJobQueue {
  constructor(options = {}) {
    // How many jobs we allow to run at once.
    this.maxParallel = Math.max(1, options.maxParallel ?? 2);
    // FIFO queue: first in, first out.
    this.pendingJobs = [];
    // We append one result per finished job (success or failure).
    this.results = [];
    this.nextId = 1;
  }

  addJob(name, durationMs, shouldFail = false) {
    if (!name || typeof name !== "string") {
      throw new Error("Job name must be a non-empty string");
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("durationMs must be a positive number");
    }

    // Keep job object plain and easy to print/debug.
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

  async runAll() {
    // Start clean every time runAll() is called.
    this.results = [];
    const workers = [];
    // Spin up N workers that all pull from the same queue.
    for (let i = 0; i < this.maxParallel; i += 1) {
      workers.push(this.runWorker(i + 1));
    }
    await Promise.all(workers);
    return this.results;
  }

  async runWorker(workerId) {
    while (this.pendingJobs.length > 0) {
      // shift() gives this worker the next available job.
      const job = this.pendingJobs.shift();
      if (!job) {
        return;
      }

      const startedAt = Date.now();
      console.log(`Worker ${workerId} started job ${job.id}: ${job.name}`);

      try {
        const message = await this.executeJob(job);
        this.results.push({
          jobId: job.id,
          name: job.name,
          status: "success",
          durationMs: Date.now() - startedAt,
          details: message
        });
      } catch (error) {
        // We store errors as results too, so the whole run still completes.
        this.results.push({
          jobId: job.id,
          name: job.name,
          status: "failed",
          durationMs: Date.now() - startedAt,
          details: error.message
        });
      }
    }
  }

  async executeJob(job) {
    // Pretend this is real async work (API call, file task, etc.).
    await sleep(job.durationMs);
    if (job.shouldFail) {
      throw new Error(`Job "${job.name}" failed intentionally for demo`);
    }
    return `Job "${job.name}" finished normally`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function demoQueue() {
  const queue = new SimpleJobQueue({ maxParallel: 2 });

  queue.addJob("compile-assets", 500, false);
  queue.addJob("send-emails", 350, false);
  queue.addJob("generate-report", 450, true);
  queue.addJob("cleanup-temp-files", 250, false);

  const results = await queue.runAll();

  console.log("\nFinal result table:");
  console.table(results);
}

if (require.main === module) {
  demoQueue().catch((error) => {
    console.error("Unexpected demo error:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { SimpleJobQueue };
