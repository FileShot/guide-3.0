'use strict';

/**
 * Background agent job queue — runs tasks asynchronously via spawnSubAgent.
 * Jobs are processed one at a time; completion is pushed to the renderer via IPC.
 */
class BackgroundAgentQueue {
  constructor({ llmEngine, settingsManager, sendEvent }) {
    this.llmEngine = llmEngine;
    this.settingsManager = settingsManager;
    this.sendEvent = sendEvent;
    this.jobs = [];
    this._processing = false;
    this._nextId = 1;
  }

  enqueue({ task, context } = {}) {
    const job = {
      id: `bg-${this._nextId++}`,
      task: String(task || '').trim(),
      context: context || {},
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
    if (!job.task) throw new Error('task is required');
    this.jobs.push(job);
    this._kick();
    return { ...job };
  }

  list() {
    return this.jobs.map((j) => ({ ...j }));
  }

  get(id) {
    const job = this.jobs.find((j) => j.id === id);
    return job ? { ...job } : null;
  }

  _kick() {
    if (this._processing) return;
    this._processNext().catch((err) => {
      console.error('[BackgroundAgentQueue] process error:', err.message);
      this._processing = false;
    });
  }

  async _processNext() {
    const pending = this.jobs.find((j) => j.status === 'queued');
    if (!pending) return;

    this._processing = true;
    pending.status = 'running';
    pending.startedAt = Date.now();

    try {
      if (!this.llmEngine?._model) {
        throw new Error('No model loaded — load a model before running background agents');
      }
      const settings = typeof this.settingsManager?.getAll === 'function'
        ? this.settingsManager.getAll()
        : {};
      const result = await this.llmEngine.spawnSubAgent(pending.task, {
        contextSize: pending.context?.contextSize,
        temperature: settings.temperature,
      });
      pending.status = result.success ? 'completed' : 'failed';
      pending.result = result.result || null;
      pending.error = result.error || null;
    } catch (err) {
      pending.status = 'failed';
      pending.error = err.message;
    }

    pending.completedAt = Date.now();
    this.sendEvent('background-agent-complete', {
      jobId: pending.id,
      task: pending.task,
      status: pending.status,
      result: pending.result,
      error: pending.error,
    });

    this._processing = false;
    this._kick();
  }
}

module.exports = { BackgroundAgentQueue };
