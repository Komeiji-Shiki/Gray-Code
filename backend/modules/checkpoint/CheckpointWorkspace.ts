import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface CheckpointWorkspaceRoot {
    id: string;
    name: string;
    uri: string;
}

export interface RuntimeWorkspaceRoot extends CheckpointWorkspaceRoot {
    fsPath: string;
}

export interface WorkspaceRootInput {
    name: string;
    uri: string;
    fsPath: string;
}

export interface CheckpointWorkspaceSnapshot {
    workspaceRoots: CheckpointWorkspaceRoot[];
    workspaceFingerprint: string;
}

export type WorkspaceValidationResult =
    | { valid: true; roots: RuntimeWorkspaceRoot[] }
    | {
        valid: false;
        code: 'WORKSPACE_IDENTITY_MISSING' | 'WORKSPACE_MISMATCH';
        message: string;
        missingRootIds?: string[];
        unexpectedRootIds?: string[];
    };

export class CheckpointPathError extends Error {
    constructor(
        readonly code: 'INVALID_CHECKPOINT_PATH' | 'CHECKPOINT_PATH_OUTSIDE_WORKSPACE' | 'CHECKPOINT_PATH_SYMLINK',
        message: string
    ) {
        super(message);
        this.name = 'CheckpointPathError';
    }
}

function normalizeWorkspaceUri(uri: string): string {
    const normalized = uri.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function createWorkspaceRootId(uri: string): string {
    return `ws_${hash(normalizeWorkspaceUri(uri)).slice(0, 16)}`;
}

export function createRuntimeWorkspaceRoots(inputs: readonly WorkspaceRootInput[]): RuntimeWorkspaceRoot[] {
    const roots = inputs.map(input => ({
        id: createWorkspaceRootId(input.uri),
        name: input.name,
        uri: normalizeWorkspaceUri(input.uri),
        fsPath: path.resolve(input.fsPath)
    }));

    const duplicate = roots.find((root, index) => roots.findIndex(candidate => candidate.id === root.id) !== index);
    if (duplicate) {
        throw new Error(`Duplicate workspace root identity: ${duplicate.uri}`);
    }

    return roots.sort((left, right) => left.id.localeCompare(right.id));
}

export function createWorkspaceSnapshot(roots: readonly RuntimeWorkspaceRoot[]): CheckpointWorkspaceSnapshot {
    const workspaceRoots = roots
        .map(({ id, name, uri }) => ({ id, name, uri }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const workspaceFingerprint = hash(
        workspaceRoots.map(root => `${root.id}\n${normalizeWorkspaceUri(root.uri)}`).join('\n---\n')
    );
    return { workspaceRoots, workspaceFingerprint };
}

export function validateWorkspaceSnapshot(
    recordedRoots: readonly CheckpointWorkspaceRoot[] | undefined,
    recordedFingerprint: string | undefined,
    currentRoots: readonly RuntimeWorkspaceRoot[]
): WorkspaceValidationResult {
    if (!recordedRoots?.length || !recordedFingerprint) {
        return {
            valid: false,
            code: 'WORKSPACE_IDENTITY_MISSING',
            message: 'Checkpoint does not contain workspace identity metadata'
        };
    }

    const currentSnapshot = createWorkspaceSnapshot(currentRoots);
    const recordedIds = new Set(recordedRoots.map(root => root.id));
    const currentIds = new Set(currentRoots.map(root => root.id));
    const missingRootIds = [...recordedIds].filter(id => !currentIds.has(id));
    const unexpectedRootIds = [...currentIds].filter(id => !recordedIds.has(id));
    const recordedUris = new Map(recordedRoots.map(root => [root.id, normalizeWorkspaceUri(root.uri)]));
    const uriMismatch = currentRoots.some(root => recordedUris.get(root.id) !== normalizeWorkspaceUri(root.uri));

    if (
        recordedFingerprint !== currentSnapshot.workspaceFingerprint
        || missingRootIds.length > 0
        || unexpectedRootIds.length > 0
        || uriMismatch
    ) {
        return {
            valid: false,
            code: 'WORKSPACE_MISMATCH',
            message: 'Current workspace roots do not match the checkpoint workspace roots',
            missingRootIds,
            unexpectedRootIds
        };
    }

    return { valid: true, roots: [...currentRoots] };
}

export function normalizeSafeCheckpointPath(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', 'Checkpoint path is empty or invalid');
    }

    const normalizedSeparators = relativePath.replace(/\\/g, '/');
    if (
        normalizedSeparators.startsWith('/')
        || normalizedSeparators.startsWith('//')
        || /^[a-zA-Z]:/.test(normalizedSeparators)
    ) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', `Absolute checkpoint path is not allowed: ${relativePath}`);
    }

    const segments = normalizedSeparators.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.some(segment => segment === '..')) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', `Checkpoint path traversal is not allowed: ${relativePath}`);
    }

    return segments.join('/');
}

export function createWorkspaceScopedPath(rootId: string, relativePath: string): string {
    if (!/^ws_[a-f0-9]{16}$/.test(rootId)) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', `Invalid workspace root id: ${rootId}`);
    }
    return `${rootId}/${normalizeSafeCheckpointPath(relativePath)}`;
}

export function parseWorkspaceScopedPath(
    scopedPath: string,
    roots: readonly RuntimeWorkspaceRoot[]
): { root: RuntimeWorkspaceRoot; relativePath: string } {
    const normalized = normalizeSafeCheckpointPath(scopedPath);
    const separatorIndex = normalized.indexOf('/');
    if (separatorIndex <= 0) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', `Workspace-scoped path is invalid: ${scopedPath}`);
    }

    const rootId = normalized.slice(0, separatorIndex);
    const root = roots.find(candidate => candidate.id === rootId);
    if (!root) {
        throw new CheckpointPathError('CHECKPOINT_PATH_OUTSIDE_WORKSPACE', `Unknown workspace root id: ${rootId}`);
    }

    return {
        root,
        relativePath: normalizeSafeCheckpointPath(normalized.slice(separatorIndex + 1))
    };
}

export function resolvePathInsideRoot(rootPath: string, relativePath: string): string {
    const normalized = normalizeSafeCheckpointPath(relativePath);
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(resolvedRoot, ...normalized.split('/'));
    const relative = path.relative(resolvedRoot, resolvedTarget);

    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new CheckpointPathError(
            'CHECKPOINT_PATH_OUTSIDE_WORKSPACE',
            `Checkpoint path escapes workspace root: ${relativePath}`
        );
    }

    return resolvedTarget;
}

export async function resolveSafePathInsideRoot(rootPath: string, relativePath: string): Promise<string> {
    const normalized = normalizeSafeCheckpointPath(relativePath);
    const target = resolvePathInsideRoot(rootPath, normalized);
    let current = path.resolve(rootPath);

    for (const segment of normalized.split('/')) {
        current = path.join(current, segment);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink()) {
                throw new CheckpointPathError(
                    'CHECKPOINT_PATH_SYMLINK',
                    `Checkpoint path traverses a symbolic link: ${relativePath}`
                );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                break;
            }
            throw error;
        }
    }

    return target;
}
