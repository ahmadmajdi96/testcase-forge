/**
 * Playwright reporter injected into every run workspace (CommonJS so it loads
 * without a build step). It appends one JSON line per lifecycle event to
 * results/events.jsonl — the file the service tails to power the SSE live view.
 * Deterministic and service-owned: never model-generated.
 */
export const REPORTER_FILENAME = 'tcf-reporter.cjs';

export const REPORTER_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(process.cwd(), 'results', 'events.jsonl');

function emit(event) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\\n');
}

function rel(p) {
  try { return path.relative(process.cwd(), p); } catch { return String(p); }
}

class TcfReporter {
  onBegin(config, suite) {
    emit({ type: 'run_started', totalTests: suite.allTests().length, workers: config.workers });
  }
  onTestBegin(test) {
    emit({ type: 'test_started', title: test.title, file: rel(test.location.file), line: test.location.line });
  }
  onTestEnd(test, result) {
    emit({
      type: 'test_finished',
      title: test.title,
      file: rel(test.location.file),
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
      error: result.error ? String(result.error.message || '').slice(0, 600) : null,
      attachments: (result.attachments || [])
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, path: rel(a.path), contentType: a.contentType })),
    });
  }
  onStepEnd(test, result, step) {
    if (step.category === 'test.step') {
      emit({ type: 'step_finished', test: test.title, step: step.title, durationMs: step.duration, error: step.error ? String(step.error.message || '').slice(0, 300) : null });
    }
  }
  onEnd(result) {
    emit({ type: 'run_finished', status: result.status });
  }
  onError(error) {
    emit({ type: 'runner_error', error: String(error && error.message || error).slice(0, 600) });
  }
}

module.exports = TcfReporter;
`;
