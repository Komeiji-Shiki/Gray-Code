import type { StorageErrorCode } from '@graycode/contracts';

export class PlatformStorageError extends Error {
  constructor(public readonly code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'PlatformStorageError';
  }
}

export function invalid(message: string): never {
  throw new PlatformStorageError('INVALID_INPUT', message);
}

export function assertIdentifier(value: unknown, label = 'id'): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    invalid(`${label} must be a nonempty identifier of at most 512 characters`);
  }
}

export function errorDetails(error: unknown): { code: StorageErrorCode; message: string } {
  if (error instanceof PlatformStorageError) return { code: error.code, message: error.message };
  if (error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_BUSY')) {
    return { code: 'STORAGE_BUSY', message: 'The data directory is already in use by another core process.' };
  }
  return { code: 'IO_ERROR', message: error instanceof Error ? error.message : String(error) };
}
