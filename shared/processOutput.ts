export interface ProcessReadOptions {
  cursor?: number;
  maxChars?: number;
}

export class ProcessSessionError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'EXITED' | 'INPUT_CLOSED' | 'INVALID_CURSOR', message: string) {
    super(message);
    this.name = 'ProcessSessionError';
  }
}

export interface ProcessOutputBuffer {
  output: string;
  outputOffset: number;
  truncated: boolean;
}

const outputLimit = 256_000;

export function appendProcessOutput(entry: ProcessOutputBuffer, text: string): void {
  entry.output += text;
  if (entry.output.length > outputLimit) {
    entry.outputOffset += entry.output.length - outputLimit;
    entry.output = entry.output.slice(-outputLimit);
    entry.truncated = true;
  }
}

/** 两种宿主都以 UTF-16 绝对位置续读，不因缓冲截断重置游标。 */
export function readProcessOutput(entry: ProcessOutputBuffer, options: ProcessReadOptions = {}) {
  const end = entry.outputOffset + entry.output.length;
  if (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < 0 || options.cursor > end)) {
    throw new ProcessSessionError('INVALID_CURSOR', 'cursor must be a non-negative UTF-16 integer no later than nextCursor.');
  }
  if (options.maxChars !== undefined && (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > outputLimit)) {
    throw new ProcessSessionError('INVALID_CURSOR', `maxChars must be an integer between 1 and ${outputLimit}.`);
  }
  const cursor = options.cursor ?? entry.outputOffset;
  const offset = Math.max(cursor, entry.outputOffset);
  const output = entry.output.slice(offset - entry.outputOffset, offset - entry.outputOffset + (options.maxChars ?? outputLimit));
  const nextCursor = offset + output.length;
  return { output, outputOffset: offset, nextCursor, hasMore: nextCursor < end, outputLost: cursor < entry.outputOffset, truncated: entry.truncated };
}
