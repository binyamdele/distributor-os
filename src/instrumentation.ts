import { parseConfig } from '@/platform/config';

/**
 * Validates the environment once, before the server accepts a single request.
 *
 * The deployment runbook has always promised that "the application refuses to start on a bad
 * configuration rather than running degraded". It did not. Configuration is read lazily, on first
 * use, so a container with a configuration the schema refuses would start normally, log
 * `✓ Ready`, and pass its liveness healthcheck — then fail on requests once something finally
 * asked for a setting.
 *
 * That was found by rehearsing it: a container was started with `APP_ENV=production` and
 * `FILE_STORAGE_DRIVER=local` — the exact combination the config guards exist to refuse, because
 * payment evidence on a container filesystem disappears on restart — and it came up healthy.
 *
 * Why that is worse than it sounds. Platforms gate a rollout on liveness: the new container
 * answers, so traffic moves to it and the old one is retired. Nothing in that sequence consults
 * readiness. The deployment "succeeds", the distributor's staff hit errors, and the operator's
 * first clue is a support call rather than a failed deploy.
 *
 * A process that exits is unambiguous. Every platform in the runbook treats a container that
 * dies at startup as a failed release and keeps the previous one serving.
 *
 * `parseConfig` rather than `config()`: it reports every problem at once. Fixing one setting per
 * deploy attempt, five deploys running, is its own kind of outage.
 */
export async function register(): Promise<void> {
  // The edge runtime evaluates this file too, and has neither the same environment nor the same
  // process object. The Node server is the one that serves this application.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const result = parseConfig(process.env);
  if (result.ok) return;

  /*
   * Setting names and the schema's own messages. Never a value.
   *
   * This text lands in a deployment log, which is read by more people and kept for longer than
   * anybody intends. "SESSION_SECRET is a placeholder value" is what an operator needs; the
   * placeholder itself is not.
   *
   * `process.stderr` rather than the logger: the logger reads configuration, and the thing being
   * reported is that configuration cannot be read.
   */
  process.stderr.write(
    [
      '',
      'Refusing to start: the environment is not a valid configuration.',
      '',
      ...result.problems.map((problem) => `  - ${problem}`),
      '',
      'Nothing was served. See docs/secrets-and-environment.md for what each setting requires.',
      '',
    ].join('\n'),
  );

  process.exit(1);
}
