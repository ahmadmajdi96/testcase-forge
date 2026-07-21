import { spawn } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ExecOptions {
  runId: string;
  workspace: string;
  /** Host-visible path of the workspace (differs when the service runs in a container). */
  hostWorkspace: string;
  envValues: Record<string, string>;
  mode: 'docker' | 'subprocess';
  image: string;
}

export interface ExecHandle {
  /** Resolves with the process exit code (1 = tests failed, still a valid run). */
  done: Promise<number>;
  kill(): Promise<void>;
}

export type ExecutorFactory = (opts: ExecOptions) => Promise<ExecHandle>;

/**
 * Install deps then run the suite with the streaming reporter. Playwright's
 * exit code 1 means "tests failed" — a legitimate outcome, not an infra error.
 */
const RUN_SCRIPT =
  'npm install --no-fund --no-audit @playwright/test@1.49.1 > results/npm-install.log 2>&1 ' +
  '&& npx playwright test --reporter=./tcf-reporter.cjs > results/playwright.log 2>&1';

export const defaultExecutor: ExecutorFactory = async (opts) => {
  const containerName = `tcf-run-${opts.runId.slice(0, 13)}`;
  const jsonEnv = { PLAYWRIGHT_JSON_OUTPUT_NAME: 'results/results.json' };

  let child: ReturnType<typeof spawn>;

  if (opts.mode === 'docker') {
    // Secrets travel via --env-file inside the workspace (mode 600, removed with
    // the workspace) — they never appear in argv or `docker inspect` output...
    // (env-file values do appear in inspect; the container is short-lived and local).
    const envFile = join(opts.workspace, '.tcf-env');
    const lines = Object.entries({ ...opts.envValues, ...jsonEnv })
      .map(([k, v]) => `${k}=${v.replace(/\n/g, ' ')}`)
      .join('\n');
    await writeFile(envFile, lines, 'utf8');
    await chmod(envFile, 0o600);

    child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name', containerName,
        '--init',
        '-v', `${join(opts.hostWorkspace, opts.runId)}:/work`,
        '-w', '/work',
        '--memory', '2g',
        '--cpus', '2',
        '--pids-limit', '512',
        '--security-opt', 'no-new-privileges',
        '--env-file', envFile,
        opts.image,
        'bash', '-lc', RUN_SCRIPT,
      ],
      { stdio: 'ignore' },
    );
  } else {
    child = spawn('bash', ['-lc', RUN_SCRIPT], {
      cwd: opts.workspace,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...opts.envValues,
        ...jsonEnv,
      },
    });
  }

  const done = new Promise<number>((resolveDone) => {
    child.on('close', (code) => resolveDone(code ?? -1));
    child.on('error', () => resolveDone(-1));
  });

  return {
    done,
    kill: async () => {
      if (opts.mode === 'docker') {
        // Killing the docker CLI client does not stop the container; kill it by name.
        await new Promise<void>((resolveKill) => {
          const killer = spawn('docker', ['kill', containerName], { stdio: 'ignore' });
          killer.on('close', () => resolveKill());
          killer.on('error', () => resolveKill());
        });
      }
      child.kill('SIGKILL');
    },
  };
};
