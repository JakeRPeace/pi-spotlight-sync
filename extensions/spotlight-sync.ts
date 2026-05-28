import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
} from '@earendil-works/pi-coding-agent';

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface WorktreeEntry {
  path: string;
  branch?: string;
  head?: string;
  bare: boolean;
}

interface RootState {
  branch?: string;
  head: string;
}

interface SpotlightState {
  activeSource: string;
  originalRoot: RootState;
  startedAt: string;
  baseRef?: string;
  changedFileCount?: number;
  aheadCommitCount?: number;
  changeSignature?: string;
  lastSyncedAt?: string;
}

interface SpotlightSession {
  sourceRoot: string;
  rootPath: string;
  statePath: string;
  baseRef: string;
  timer?: ReturnType<typeof setInterval>;
  lastError?: string;
  changedFileCount?: number;
  aheadCommitCount?: number;
  changeSignature?: string;
  lastSyncedAt?: number;
}

const STATE_FILE_NAME = 'pi-spotlight-sync-state.json';
const DEFAULT_INTERVAL_MS = 1_500;
const DEFAULT_BASE_REF = 'origin/main';

async function run(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd?: string,
): Promise<CommandResult> {
  return pi.exec(command, args, cwd ? { cwd } : undefined);
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await run(pi, 'git', args, cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function parseArgs(args: string): {
  action: string;
  rootPath?: string;
  intervalMs: number;
  baseRef: string;
} {
  const parts = args.split(/\s+/).filter(Boolean);
  const action = parts[0] ?? 'status';
  const rootPath = parts.find((part) => part.startsWith('/') || part.startsWith('.'));
  const intervalArg = parts.find((part) => part.startsWith('--interval='));
  const baseArg = parts.find((part) => part.startsWith('--base='));
  const intervalMs = intervalArg
    ? Number(intervalArg.slice('--interval='.length))
    : DEFAULT_INTERVAL_MS;

  return {
    action,
    rootPath,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 500 ? intervalMs : DEFAULT_INTERVAL_MS,
    baseRef: baseArg?.slice('--base='.length) || DEFAULT_BASE_REF,
  };
}

function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current);
      }
      current = { path: line.slice('worktree '.length), bare: false };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line === 'bare') {
      current.bare = true;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function branchName(ref?: string): string | undefined {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readState(path: string): Promise<SpotlightState | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }

  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as SpotlightState;
}

async function writeState(path: string, state: SpotlightState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function clearState(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function getRootState(pi: ExtensionAPI, rootPath: string): Promise<RootState> {
  const head = await git(pi, rootPath, ['rev-parse', 'HEAD']);
  const branchResult = await run(pi, 'git', ['symbolic-ref', '--quiet', 'HEAD'], rootPath);
  return {
    head,
    branch: branchResult.code === 0 ? branchResult.stdout.trim() : undefined,
  };
}

async function getStatePath(pi: ExtensionAPI, rootPath: string): Promise<string> {
  const gitDir = await git(pi, rootPath, ['rev-parse', '--absolute-git-dir']);
  return join(gitDir, STATE_FILE_NAME);
}

async function hasPendingGitOperation(pi: ExtensionAPI, path: string): Promise<boolean> {
  const gitDir = await git(pi, path, ['rev-parse', '--absolute-git-dir']);
  const files = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  const checks = await Promise.all(files.map((file) => pathExists(join(gitDir, file))));
  return checks.some(Boolean);
}

async function dirtyTrackedPaths(pi: ExtensionAPI, rootPath: string): Promise<string[]> {
  const status = await git(pi, rootPath, ['status', '--porcelain', '--untracked-files=no']);
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

async function findDefaultRoot(pi: ExtensionAPI, sourceRoot: string): Promise<string> {
  const worktreeOutput = await git(pi, sourceRoot, ['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktrees(worktreeOutput).filter((entry) => !entry.bare);
  const normalizedSource = resolve(sourceRoot);
  const commonGitDir = await git(pi, sourceRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const baseRoot = basename(commonGitDir) === '.git' ? dirname(commonGitDir) : undefined;
  if (baseRoot) {
    if (resolve(baseRoot) === normalizedSource) {
      throw new Error('Run /spotlight from a linked worktree, not the base repository root.');
    }

    const baseWorktree = worktrees.find((entry) => resolve(entry.path) === resolve(baseRoot));
    if (baseWorktree) {
      return baseWorktree.path;
    }
  }

  const rootCandidates = worktrees.filter((entry) => resolve(entry.path) !== normalizedSource);
  if (rootCandidates.length === 1) {
    return rootCandidates[0].path;
  }

  const mainRoot = rootCandidates.find((entry) => branchName(entry.branch) === 'main');
  if (mainRoot) {
    return mainRoot.path;
  }

  const primaryWorktree = worktrees.find((entry) => resolve(entry.path) !== normalizedSource);
  if (primaryWorktree) {
    return primaryWorktree.path;
  }

  throw new Error('Could not identify the base repository root. Pass /spotlight on /path/to/root.');
}

async function changedTrackedPaths(
  pi: ExtensionAPI,
  sourceRoot: string,
  filter?: string,
): Promise<string[]> {
  const args = ['diff', '--name-only', 'HEAD'];
  if (filter) {
    args.splice(1, 0, `--diff-filter=${filter}`);
  }
  const output = await git(pi, sourceRoot, args);
  return output.split('\n').filter(Boolean);
}

async function changeSignature(pi: ExtensionAPI, sourceRoot: string): Promise<string> {
  const head = await git(pi, sourceRoot, ['rev-parse', 'HEAD']);
  const diff = await git(pi, sourceRoot, ['diff', '--no-ext-diff', '--binary', 'HEAD']);
  return `${head}\n${diff}`;
}

async function aheadCommitCount(
  pi: ExtensionAPI,
  sourceRoot: string,
  baseRef: string,
): Promise<number | undefined> {
  const result = await run(pi, 'git', ['rev-list', '--count', `${baseRef}..HEAD`], sourceRoot);
  if (result.code !== 0) {
    return undefined;
  }

  const count = Number(result.stdout.trim());
  return Number.isFinite(count) ? count : undefined;
}

async function stateAheadCommitCount(
  pi: ExtensionAPI,
  state: SpotlightState,
): Promise<number | undefined> {
  return (
    state.aheadCommitCount ??
    (await aheadCommitCount(pi, state.activeSource, state.baseRef ?? DEFAULT_BASE_REF))
  );
}

async function copyTrackedChanges(
  pi: ExtensionAPI,
  sourceRoot: string,
  rootPath: string,
): Promise<void> {
  const deleted = new Set(await changedTrackedPaths(pi, sourceRoot, 'D'));
  const changed = await changedTrackedPaths(pi, sourceRoot);

  for (const relativePath of changed) {
    const destination = join(rootPath, relativePath);
    if (deleted.has(relativePath)) {
      await rm(destination, { force: true });
      continue;
    }

    const source = join(sourceRoot, relativePath);
    if (!(await pathExists(source))) {
      await rm(destination, { force: true });
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function checkoutSourceHead(
  pi: ExtensionAPI,
  sourceRoot: string,
  rootPath: string,
): Promise<void> {
  const head = await git(pi, sourceRoot, ['rev-parse', 'HEAD']);
  await git(pi, rootPath, ['reset', '--hard']);
  await git(pi, rootPath, ['checkout', '--detach', head]);
}

async function syncNow(
  pi: ExtensionAPI,
  session: SpotlightSession,
  forceTimestamp = false,
): Promise<void> {
  const state = await readState(session.statePath);
  if (state?.activeSource !== session.sourceRoot) {
    stopSession(session);
    return;
  }

  const changedFileCount = (await changedTrackedPaths(pi, session.sourceRoot)).length;
  const nextAheadCommitCount = await aheadCommitCount(pi, session.sourceRoot, session.baseRef);
  const nextChangeSignature = await changeSignature(pi, session.sourceRoot);
  const previousChangeSignature = session.changeSignature ?? state.changeSignature;
  const previousLastSyncedAt = session.lastSyncedAt ?? (state.lastSyncedAt ? Date.parse(state.lastSyncedAt) : undefined);
  const shouldUpdateLastSyncedAt = forceTimestamp || previousChangeSignature !== nextChangeSignature || !previousLastSyncedAt;

  await checkoutSourceHead(pi, session.sourceRoot, session.rootPath);
  await copyTrackedChanges(pi, session.sourceRoot, session.rootPath);
  session.changedFileCount = changedFileCount;
  session.aheadCommitCount = nextAheadCommitCount;
  session.changeSignature = nextChangeSignature;
  session.lastSyncedAt = shouldUpdateLastSyncedAt ? Date.now() : previousLastSyncedAt;
  session.lastError = undefined;
  await writeState(session.statePath, {
    ...state,
    changedFileCount,
    baseRef: session.baseRef,
    aheadCommitCount: nextAheadCommitCount,
    changeSignature: nextChangeSignature,
    lastSyncedAt: session.lastSyncedAt ? new Date(session.lastSyncedAt).toISOString() : undefined,
  });
}

function stopSession(session?: SpotlightSession): void {
  if (session?.timer) {
    clearInterval(session.timer);
    session.timer = undefined;
  }
}

async function restoreRoot(
  pi: ExtensionAPI,
  state: SpotlightState,
  rootPath: string,
): Promise<void> {
  await git(pi, rootPath, ['reset', '--hard']);
  const target = branchName(state.originalRoot.branch) ?? state.originalRoot.head;
  await git(pi, rootPath, ['checkout', target]);
  await git(pi, rootPath, ['reset', '--hard', state.originalRoot.head]);
}

function relativeTime(timestamp: number | undefined): string | undefined {
  if (!timestamp) {
    return undefined;
  }

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  return `${Math.floor(minutes / 60)}h ago`;
}

function statusSuffix(
  changedFileCount?: number,
  lastSyncedAt?: number,
  aheadCommitCount?: number,
): string {
  const parts: string[] = [];
  if (changedFileCount !== undefined) {
    parts.push(`${changedFileCount} ${changedFileCount === 1 ? 'file' : 'files'}`);
  }
  if (aheadCommitCount !== undefined) {
    parts.push(`${aheadCommitCount} ${aheadCommitCount === 1 ? 'commit' : 'commits'} ahead`);
  }

  const syncedAgo = relativeTime(lastSyncedAt);
  if (syncedAgo) {
    parts.push(syncedAgo);
  }

  return parts.length > 0 ? ` ${parts.join(' · ')}` : '';
}

function stateLastSyncedAt(state: SpotlightState): number | undefined {
  return state.lastSyncedAt ? Date.parse(state.lastSyncedAt) : undefined;
}

function statusText(session: SpotlightSession | undefined): string {
  if (!session) {
    return 'Spotlight sync is off.';
  }

  const details = [
    `Spotlight sync is on${statusSuffix(session.changedFileCount, session.lastSyncedAt, session.aheadCommitCount)}.`,
    `source: ${session.sourceRoot}`,
    `root: ${session.rootPath}`,
    `base: ${session.baseRef}`,
  ];
  if (session.lastSyncedAt) {
    details.push(`last synced: ${new Date(session.lastSyncedAt).toLocaleString()}`);
  }
  if (session.lastError) {
    details.push(`last error: ${session.lastError}`);
  }
  return details.join('\n');
}

function stateStatusText(
  state: SpotlightState,
  rootPath: string,
  currentAheadCommitCount?: number,
): string {
  const lastSyncedAt = stateLastSyncedAt(state);
  const details = [
    `Spotlight sync is active${statusSuffix(
      state.changedFileCount,
      lastSyncedAt,
      currentAheadCommitCount ?? state.aheadCommitCount,
    )}.`,
    `source: ${state.activeSource}`,
    `root: ${rootPath}`,
    `base: ${state.baseRef ?? DEFAULT_BASE_REF}`,
  ];
  if (lastSyncedAt) {
    details.push(`last synced: ${new Date(lastSyncedAt).toLocaleString()}`);
  }
  return details.join('\n');
}

export default function spotlightSyncExtension(pi: ExtensionAPI): void {
  let session: SpotlightSession | undefined;
  let clearFlashTimer: ReturnType<typeof setTimeout> | undefined;

  type SpotlightStatus = 'beaming' | 'borrowed' | 'flashing' | 'blocked' | 'off';

  function setSpotlightStatus(
    ctx: ExtensionContext,
    status: SpotlightStatus,
    changedFileCount?: number,
    lastSyncedAt?: number,
    aheadCommitCount?: number,
  ): void {
    if (!ctx.hasUI) {
      return;
    }

    if (status === 'off') {
      ctx.ui.setStatus('spotlight-sync', undefined);
      return;
    }

    const labels: Record<Exclude<SpotlightStatus, 'off'>, { color: ThemeColor; text: string }> = {
      beaming: { color: 'success', text: '🔦 beaming' },
      borrowed: { color: 'accent', text: '🔦 borrowed' },
      flashing: { color: 'warning', text: '✨ flashing' },
      blocked: { color: 'error', text: '💥 beam blocked' },
    };
    const label = labels[status];
    ctx.ui.setStatus(
      'spotlight-sync',
      ctx.ui.theme.fg(
        label.color,
        `${label.text}${statusSuffix(changedFileCount, lastSyncedAt, aheadCommitCount)}`,
      ),
    );
  }

  function flashSpotlightStatus(
    ctx: ExtensionContext,
    status: SpotlightStatus,
    changedFileCount?: number,
    lastSyncedAt?: number,
    aheadCommitCount?: number,
  ): void {
    if (clearFlashTimer) {
      clearTimeout(clearFlashTimer);
      clearFlashTimer = undefined;
    }

    setSpotlightStatus(ctx, status, changedFileCount, lastSyncedAt, aheadCommitCount);
    clearFlashTimer = setTimeout(() => {
      void refreshSpotlightStatus(ctx);
    }, 4_000);
  }

  async function refreshSpotlightStatus(ctx: ExtensionContext): Promise<void> {
    if (session?.lastError) {
      setSpotlightStatus(
        ctx,
        'blocked',
        session.changedFileCount,
        session.lastSyncedAt,
        session.aheadCommitCount,
      );
      return;
    }

    if (session?.timer) {
      setSpotlightStatus(
        ctx,
        'beaming',
        session.changedFileCount,
        session.lastSyncedAt,
        session.aheadCommitCount,
      );
      return;
    }

    try {
      const sourceRoot = await git(pi, ctx.cwd, ['rev-parse', '--show-toplevel']);
      const rootPath = await findDefaultRoot(pi, sourceRoot);
      const state = await readState(await getStatePath(pi, rootPath));

      if (!state) {
        setSpotlightStatus(ctx, 'off');
        return;
      }

      const currentAheadCommitCount = await stateAheadCommitCount(pi, state);
      setSpotlightStatus(
        ctx,
        state.activeSource === sourceRoot ? 'flashing' : 'borrowed',
        state.changedFileCount,
        stateLastSyncedAt(state),
        currentAheadCommitCount,
      );
    } catch {
      setSpotlightStatus(ctx, 'off');
    }
  }

  async function handleSpotlightCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const { action, rootPath, intervalMs, baseRef } = parseArgs(args);
    const sourceRoot = await git(pi, ctx.cwd, ['rev-parse', '--show-toplevel']);

    if (action === 'status') {
      if (session) {
        ctx.ui.notify(statusText(session), 'info');
        return;
      }

      const statusRoot = rootPath
        ? resolve(ctx.cwd, rootPath)
        : await findDefaultRoot(pi, sourceRoot);
      const state = await readState(await getStatePath(pi, statusRoot));
      const currentAheadCommitCount = state ? await stateAheadCommitCount(pi, state) : undefined;
      ctx.ui.notify(
        state ? stateStatusText(state, statusRoot, currentAheadCommitCount) : 'Spotlight sync is off.',
        'info',
      );
      return;
    }

    if (action === 'off' || action === 'stop') {
      const targetRoot =
        session?.rootPath ??
        (rootPath ? resolve(ctx.cwd, rootPath) : await findDefaultRoot(pi, sourceRoot));
      const targetStatePath = session?.statePath ?? (await getStatePath(pi, targetRoot));
      const state = await readState(targetStatePath);

      stopSession(session);
      session = undefined;
      if (!state) {
        setSpotlightStatus(ctx, 'off');
        ctx.ui.notify('Spotlight sync is already off.', 'info');
        return;
      }

      if (state.activeSource !== sourceRoot) {
        const currentAheadCommitCount = await stateAheadCommitCount(pi, state);
        setSpotlightStatus(
          ctx,
          'borrowed',
          state.changedFileCount,
          stateLastSyncedAt(state),
          currentAheadCommitCount,
        );
        ctx.ui.notify(
          `Spotlight sync is active from another worktree:\n${state.activeSource}`,
          'warning',
        );
        return;
      }

      await restoreRoot(pi, state, targetRoot);
      await clearState(targetStatePath);
      setSpotlightStatus(ctx, 'off');
      ctx.ui.notify('Spotlight sync stopped.', 'info');
      return;
    }

    if (action !== 'on' && action !== 'start' && action !== 'sync' && action !== 'update') {
      ctx.ui.notify(
        'Usage: /beam on [base-root-path] [--interval=1500] [--base=origin/main], /beam update [base-root-path], /beam off, /beam status',
        'error',
      );
      return;
    }

    const isOneShotUpdate = action === 'sync' || action === 'update';

    const destinationRoot = rootPath
      ? resolve(ctx.cwd, rootPath)
      : await findDefaultRoot(pi, sourceRoot);
    if (resolve(destinationRoot) === resolve(sourceRoot)) {
      setSpotlightStatus(ctx, 'blocked');
      ctx.ui.notify('Run /spotlight from a linked worktree, not the repository root.', 'error');
      return;
    }

    if (
      (await hasPendingGitOperation(pi, sourceRoot)) ||
      (await hasPendingGitOperation(pi, destinationRoot))
    ) {
      setSpotlightStatus(ctx, 'blocked');
      ctx.ui.notify(
        'Finish or abort the pending git operation before starting spotlight sync.',
        'error',
      );
      return;
    }

    const statePath = await getStatePath(pi, destinationRoot);
    const currentState = await readState(statePath);
    const dirtyRootPaths = await dirtyTrackedPaths(pi, destinationRoot);
    if (!currentState && dirtyRootPaths.length > 0) {
      setSpotlightStatus(ctx, 'blocked');
      ctx.ui.notify(
        `Beam blocked: repository root has tracked changes. Commit, stash, or clean them first.\n\n${dirtyRootPaths.slice(0, 12).join('\n')}`,
        'error',
      );
      return;
    }

    stopSession(session);
    const originalRoot = currentState?.originalRoot ?? (await getRootState(pi, destinationRoot));
    const nextState: SpotlightState = {
      ...currentState,
      activeSource: sourceRoot,
      originalRoot,
      startedAt: currentState?.startedAt ?? new Date().toISOString(),
      baseRef,
    };
    await writeState(statePath, nextState);

    session = { sourceRoot, rootPath: destinationRoot, statePath, baseRef };
    await syncNow(pi, session, true);

    if (!isOneShotUpdate) {
      session.timer = setInterval(() => {
        const activeSession = session;
        if (!activeSession) {
          return;
        }

        syncNow(pi, activeSession)
          .then(() => {
            if (session !== activeSession) {
              return;
            }

            setSpotlightStatus(
              ctx,
              'beaming',
              activeSession.changedFileCount,
              activeSession.lastSyncedAt,
              activeSession.aheadCommitCount,
            );
          })
          .catch((error: unknown) => {
            if (session !== activeSession) {
              return;
            }

            activeSession.lastError = error instanceof Error ? error.message : String(error);
            setSpotlightStatus(
              ctx,
              'blocked',
              activeSession.changedFileCount,
              activeSession.lastSyncedAt,
              activeSession.aheadCommitCount,
            );
          });
      }, intervalMs);
    }

    if (isOneShotUpdate) {
      flashSpotlightStatus(
        ctx,
        'flashing',
        session.changedFileCount,
        session.lastSyncedAt,
        session.aheadCommitCount,
      );
    } else {
      setSpotlightStatus(
        ctx,
        'beaming',
        session.changedFileCount,
        session.lastSyncedAt,
        session.aheadCommitCount,
      );
    }
    ctx.ui.notify(
      `Spotlight sync ${isOneShotUpdate ? 'updated' : 'enabled'}. Root: ${destinationRoot}`,
      'info',
    );
  }

  pi.registerCommand('spotlight', {
    description: 'Mirror this worktree into the repository root for one-root testing',
    handler: handleSpotlightCommand,
  });

  pi.registerCommand('beam', {
    description: 'Alias for /spotlight',
    handler: handleSpotlightCommand,
  });

  pi.registerCommand('beaming', {
    description: 'Alias for /spotlight status',
    handler: async (args, ctx) => handleSpotlightCommand(`status ${args}`.trim(), ctx),
  });

  pi.on('session_start', async (_event, ctx) => {
    await refreshSpotlightStatus(ctx);
  });

  pi.on('turn_start', async (_event, ctx) => {
    await refreshSpotlightStatus(ctx);
  });

  pi.on('session_shutdown', () => {
    if (clearFlashTimer) {
      clearTimeout(clearFlashTimer);
    }
    stopSession(session);
  });
}
