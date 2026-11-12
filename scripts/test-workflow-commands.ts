import type { TestWorkflowCommand } from './test-workflow-policy';

export function commandIdentity(command: TestWorkflowCommand): string {
  return JSON.stringify([command.runtime ?? 'bun', command.args,
    Object.entries(command.env ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Inventory visits every package alias; execution keeps build prerequisites opaque. */
export function expandTestCommand(
  command: TestWorkflowCommand,
  scripts: Record<string, string>,
  scope: 'execution' | 'inventory' = 'execution',
  ancestors: string[] = []
): TestWorkflowCommand[] {
  const [verb, name] = command.args;
  if (verb !== 'run' || !name || scope === 'execution' && !name.startsWith('test:')) return [command];
  if (command.args.length !== 2) throw new Error(`Test alias arguments cannot be expanded: ${name}`);
  if (ancestors.includes(name)) throw new Error(`Cyclic package script: ${[...ancestors, name].join(' -> ')}`);
  const body = scripts[name];
  if (!body) throw new Error(`Missing package script: ${name}`);
  return body.split('&&').flatMap(part => {
    const text = part.trim();
    const alias = /^bun run ([\w:-]+)$/.exec(text);
    if (alias) return expandTestCommand({ ...command, args: ['run', alias[1]!] }, scripts, scope, [...ancestors, name]);
    const direct = /^(bun|node) (scripts\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs))(?: ([\w=./:-]+(?: [\w=./:-]+)*))?$/.exec(text);
    if (direct) return [{ ...command, ...(direct[1] === 'node' ? { runtime: 'node' as const } : {}),
      args: [direct[2]!, ...(direct[3]?.split(' ') ?? [])] }];
    // Never drop a test hidden behind unsupported shell syntax.
    if (name === 'test' || name.startsWith('test:') || /scripts\/test-/.test(text)) {
      throw new Error(`Unsupported test command in ${name}: ${text}`);
    }
    return [];
  });
}
