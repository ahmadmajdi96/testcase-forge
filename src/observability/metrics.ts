type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');
}

class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.05, 0.25, 1, 5, 15, 60, 180, 600];

class Histogram {
  private readonly buckets = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[] = DEFAULT_BUCKETS,
  ) {}

  observe(seconds: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const counts = this.buckets.get(key) ?? new Array(this.bounds.length).fill(0);
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (seconds <= this.bounds[i]!) counts[i]! += 1;
    }
    this.buckets.set(key, counts);
    this.sums.set(key, (this.sums.get(key) ?? 0) + seconds);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const [key, counts] of this.buckets) {
      const prefix = key ? `${key},` : '';
      for (let i = 0; i < this.bounds.length; i += 1) {
        lines.push(
          `${this.name}_bucket{${prefix}le="${this.bounds[i]}"} ${counts[i]}`,
        );
      }
      lines.push(
        `${this.name}_bucket{${prefix}le="+Inf"} ${this.counts.get(key) ?? 0}`,
      );
      lines.push(
        key
          ? `${this.name}_sum{${key}} ${this.sums.get(key) ?? 0}`
          : `${this.name}_sum ${this.sums.get(key) ?? 0}`,
      );
      lines.push(
        key
          ? `${this.name}_count{${key}} ${this.counts.get(key) ?? 0}`
          : `${this.name}_count ${this.counts.get(key) ?? 0}`,
      );
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter(
    'tcf_http_requests_total',
    'HTTP requests by route, method and status class.',
  ),
  httpDuration: new Histogram(
    'tcf_http_request_duration_seconds',
    'HTTP request duration in seconds.',
  ),
  jobsStarted: new Counter('tcf_jobs_started_total', 'Generation jobs started.'),
  jobsFinished: new Counter(
    'tcf_jobs_finished_total',
    'Generation jobs finished by terminal state.',
  ),
  jobDuration: new Histogram(
    'tcf_job_duration_seconds',
    'End-to-end generation job duration in seconds.',
  ),
  llmCalls: new Counter(
    'tcf_llm_calls_total',
    'Novita chat completion calls by outcome.',
  ),
  llmDuration: new Histogram(
    'tcf_llm_call_duration_seconds',
    'Novita chat completion latency in seconds.',
  ),
  llmTokens: new Counter('tcf_llm_tokens_total', 'Novita tokens by direction.'),
  testCases: new Counter(
    'tcf_test_cases_total',
    'Test cases produced by generation origin.',
  ),
  coverageRatio: new Gauge(
    'tcf_last_job_coverage_ratio',
    'Coverage ratio of the most recently completed job.',
  ),
  activeJobs: new Gauge('tcf_active_jobs', 'Jobs currently queued or running.'),
  circuitOpen: new Gauge(
    'tcf_novita_circuit_open',
    'Novita circuit breaker state (1 = open).',
  ),
  codegenJobs: new Counter(
    'tcf_codegen_jobs_total',
    'Codegen jobs by terminal state.',
  ),
  codegenFiles: new Counter(
    'tcf_codegen_files_total',
    'Generated Playwright spec files by outcome.',
  ),
  testRuns: new Counter('tcf_test_runs_total', 'Test runs by terminal state.'),
};

export function renderMetrics(): string {
  return (
    [
      metrics.httpRequests,
      metrics.httpDuration,
      metrics.jobsStarted,
      metrics.jobsFinished,
      metrics.jobDuration,
      metrics.llmCalls,
      metrics.llmDuration,
      metrics.llmTokens,
      metrics.testCases,
      metrics.coverageRatio,
      metrics.activeJobs,
      metrics.circuitOpen,
      metrics.codegenJobs,
      metrics.codegenFiles,
      metrics.testRuns,
    ]
      .map((m) => m.render())
      .join('\n') + '\n'
  );
}
