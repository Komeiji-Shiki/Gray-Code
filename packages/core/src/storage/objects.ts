import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { decode, encode, ExtData } from '@msgpack/msgpack';
import type { SqliteConnection } from './schema';
import { PlatformStorageError, invalid } from '../errors';

const CHUNK_BYTES = 256 * 1024;
const EXTERNAL_OBJECT_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 128 * 1024 * 1024;
const ATTACHMENT_REFERENCE = 42;
const UTF8_REFERENCE = 43;
const UTF16_REFERENCE = 44;
const DICTIONARY_VALUE = 45;
const BINARY_REFERENCE = 46;
const INVALID_UTF16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function digest(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export interface ValueProjection { fields?: readonly string[]; omitBinary?: boolean }

interface ChunkRow { hash: Buffer; raw_bytes: number; codec: number; data: Buffer | null; file_id: string | null }

/** Immutable, chunked content. SQL references commit only after external bytes are durable. */
export class ObjectStore {
  constructor(private readonly db: SqliteConnection, private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  put(bytes: Uint8Array): Buffer {
    if (bytes.byteLength > MAX_VALUE_BYTES) invalid('An individual stored value exceeds 128 MiB.');
    const hash = digest(bytes);
    if (this.db.prepare('SELECT 1 FROM objects WHERE hash=?').get(hash)) return hash;
    const chunks: Buffer[] = [];
    let storedBytes = 0;
    for (let offset = 0; offset < bytes.byteLength || offset === 0; offset += CHUNK_BYTES) {
      const raw = Buffer.from(bytes.subarray(offset, offset + CHUNK_BYTES));
      const chunkHash = digest(raw);
      const existing = this.db.prepare('SELECT stored_bytes FROM chunks WHERE hash=?').get(chunkHash) as { stored_bytes: number } | undefined;
      if (existing) {
        storedBytes += existing.stored_bytes;
        chunks.push(chunkHash);
        continue;
      }
      const compressed = raw.length >= 1024
        ? zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }) : raw;
      const codec = compressed.length + 32 < raw.length ? 1 : 0;
      const data = codec ? compressed : raw;
      const fileId = bytes.byteLength >= EXTERNAL_OBJECT_BYTES && data.length >= 64 * 1024
        ? this.writeExternal(data) : null;
      this.db.prepare('INSERT INTO chunks(hash,raw_bytes,stored_bytes,codec,data,file_id) VALUES(?,?,?,?,?,?)')
        .run(chunkHash, raw.length, data.length, codec, fileId ? null : data, fileId);
      storedBytes += data.length;
      chunks.push(chunkHash);
    }
    this.db.prepare('INSERT INTO objects(hash,raw_bytes,stored_bytes,chunk_count) VALUES(?,?,?,?)')
      .run(hash, bytes.byteLength, storedBytes, chunks.length);
    const insert = this.db.prepare('INSERT INTO object_chunks(object_hash,ordinal,chunk_hash) VALUES(?,?,?)');
    chunks.forEach((chunk, ordinal) => insert.run(hash, ordinal, chunk));
    return hash;
  }

  get(hash: Buffer): Buffer {
    const object = this.db.prepare('SELECT raw_bytes,chunk_count FROM objects WHERE hash=?').get(hash) as { raw_bytes: number; chunk_count: number } | undefined;
    if (!object) throw new PlatformStorageError('CORRUPT_DATA', 'Referenced content object is missing.');
    if (object.raw_bytes < 0 || object.raw_bytes > MAX_VALUE_BYTES) throw new PlatformStorageError('CORRUPT_DATA', 'Invalid content length.');
    const chunks = this.db.prepare(`SELECT c.* FROM object_chunks oc JOIN chunks c ON c.hash=oc.chunk_hash
      WHERE oc.object_hash=? ORDER BY oc.ordinal`).all(hash) as ChunkRow[];
    if (chunks.length !== object.chunk_count) throw new PlatformStorageError('CORRUPT_DATA', 'Content chunks are missing.');
    const bytes = Buffer.concat(chunks.map(chunk => this.readChunk(chunk)));
    if (bytes.length !== object.raw_bytes || !digest(bytes).equals(hash)) {
      throw new PlatformStorageError('CORRUPT_DATA', 'Content checksum does not match.');
    }
    return bytes;
  }

  /** Only objects referenced by the selected message are decoded; attachments remain lossless. */
  putValue(value: unknown): Buffer {
    const children: Buffer[] = [];
    const ancestors = new Set<object>();
    const transform = (input: unknown, key: string, depth: number): unknown => {
      if (depth > 128) invalid('Stored value nesting exceeds 128 levels.');
      if (input === null || typeof input === 'boolean') return input;
      if (input instanceof Uint8Array) {
        if (input.byteLength <= 32 * 1024) return input;
        // 文件快照字节与历史附件一样分块去重，不让整批恢复记录受单值大小限制。
        const child = this.put(input); children.push(child);
        return new ExtData(BINARY_REFERENCE, child);
      }
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) invalid('Stored numbers must be finite.');
        return input;
      }
      if (typeof input === 'string') {
        if (INVALID_UTF16.test(input)) {
          const child = this.put(Buffer.from(input, 'utf16le'));
          children.push(child);
          return new ExtData(UTF16_REFERENCE, child);
        }
        if (input.length > 32 * 1024) {
          const child = this.put(Buffer.from(input, 'utf8'));
          children.push(child);
          return new ExtData(UTF8_REFERENCE, child);
        }
        return input;
      }
      if (typeof input !== 'object' || input === undefined) invalid('Stored values must be JSON-compatible.');
      if (ancestors.has(input)) invalid('Stored values cannot contain cycles.');
      const proto = Object.getPrototypeOf(input);
      if (!Array.isArray(input) && proto !== Object.prototype && proto !== null) invalid('Stored values must use plain objects.');
      ancestors.add(input);
      try {
        if (Array.isArray(input)) return input.map(item => transform(item === undefined ? null : item, '', depth + 1));
        const record = input as Record<string, unknown>;
        if (Object.keys(record).some(name => name === '__proto__' || INVALID_UTF16.test(name))) {
          // MessagePack's safe map decoder rejects __proto__; encode such dictionaries as entry data.
          const entries = Object.entries(record).filter(([, item]) => item !== undefined)
            .map(([name, item]) => [transform(name, '', depth + 1), transform(item, name, depth + 1)]);
          return new ExtData(DICTIONARY_VALUE, encode(entries));
        }
        if (key === 'inlineData' && typeof record.mimeType === 'string' && typeof record.data === 'string') {
          const binary = Buffer.from(record.data, 'base64');
          // Preserve noncanonical or invalid Base64 exactly rather than silently normalizing it.
          if (binary.toString('base64') === record.data) {
            const child = this.put(binary);
            children.push(child);
            return Object.fromEntries(Object.entries(record).map(([name, item]) => [name,
              name === 'data' ? new ExtData(ATTACHMENT_REFERENCE, child) : transform(item, name, depth + 1),
            ]));
          }
        }
        return Object.fromEntries(Object.entries(record)
          .filter(([, item]) => item !== undefined)
          .map(([name, item]) => [name, transform(item, name, depth + 1)]));
      } finally { ancestors.delete(input); }
    };
    const packed = encode(transform(value, '', 0), { sortKeys: true });
    const hash = this.put(packed);
    const edge = this.db.prepare('INSERT OR IGNORE INTO object_edges(parent_hash,child_hash) VALUES(?,?)');
    children.forEach(child => edge.run(hash, child));
    return hash;
  }

  getValue<T = unknown>(hash: Buffer, projection?: ValueProjection): T {
    const restore = (value: unknown, depth = 0): unknown => {
      if (depth > 128) throw new PlatformStorageError('CORRUPT_DATA', 'Stored value nesting exceeds 128 levels.');
      if (value instanceof Uint8Array) return projection?.omitBinary ? new Uint8Array() : value;
      if (value instanceof ExtData) {
        if (value.type === DICTIONARY_VALUE && typeof value.data !== 'function') {
          const entries = decode(value.data);
          if (!Array.isArray(entries)) throw new PlatformStorageError('CORRUPT_DATA', 'Invalid dictionary payload.');
          return Object.fromEntries(entries.flatMap(pair => {
            if (!Array.isArray(pair) || pair.length !== 2) throw new PlatformStorageError('CORRUPT_DATA', 'Invalid dictionary entry.');
            const key = restore(pair[0], depth + 1);
            if (typeof key !== 'string') throw new PlatformStorageError('CORRUPT_DATA', 'Invalid dictionary key.');
            if (depth === 0 && projection?.fields && !projection.fields.includes(key)) return [];
            return [[key, restore(pair[1], depth + 1)]];
          }));
        }
        if (![ATTACHMENT_REFERENCE, UTF8_REFERENCE, UTF16_REFERENCE, BINARY_REFERENCE].includes(value.type) || typeof value.data === 'function' || value.data.length !== 32) {
          throw new PlatformStorageError('CORRUPT_DATA', 'Unknown stored content reference.');
        }
        if (projection?.omitBinary && value.type === ATTACHMENT_REFERENCE) return '';
        if (projection?.omitBinary && value.type === BINARY_REFERENCE) return new Uint8Array();
        const content = this.get(Buffer.from(value.data));
        if (value.type === BINARY_REFERENCE) return new Uint8Array(content);
        return content.toString(value.type === ATTACHMENT_REFERENCE ? 'base64' : value.type === UTF16_REFERENCE ? 'utf16le' : 'utf8');
      }
      if (value instanceof Uint8Array) return value;
      if (Array.isArray(value)) return value.map(item => restore(item, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => depth !== 0 || !projection?.fields || projection.fields.includes(key))
        .map(([key, item]) => [key, restore(item, depth + 1)]));
      return value;
    };
    try {
      return restore(decode(this.get(hash), {
        maxStrLength: MAX_VALUE_BYTES, maxBinLength: MAX_VALUE_BYTES,
        maxArrayLength: 1_000_000, maxMapLength: 1_000_000,
      })) as T;
    } catch (error) {
      if (error instanceof PlatformStorageError) throw error;
      throw new PlatformStorageError('CORRUPT_DATA', `Cannot decode stored content: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private filePath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PlatformStorageError('CORRUPT_DATA', 'Invalid external content path.');
    return path.join(this.root, id.slice(0, 2), `${id}.bin`);
  }

  private writeExternal(bytes: Buffer): string {
    const id = digest(bytes).toString('hex');
    const file = this.filePath(id);
    if (fs.existsSync(file)) {
      if (!digest(fs.readFileSync(file)).equals(Buffer.from(id, 'hex'))) throw new PlatformStorageError('CORRUPT_DATA', 'Existing external content is corrupt.');
      return id;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx');
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* A later maintenance pass can remove an owned temp file. */ }
      throw error;
    }
    return id;
  }

  private readChunk(chunk: ChunkRow): Buffer {
    try {
      const stored = chunk.data ?? fs.readFileSync(this.filePath(chunk.file_id!));
      if (chunk.raw_bytes < 0 || chunk.raw_bytes > CHUNK_BYTES) throw new Error('Invalid chunk size');
      if (chunk.codec !== 0 && chunk.codec !== 1) throw new Error('Unsupported chunk codec');
      const raw = chunk.codec === 1 ? zstdDecompressSync(stored, { maxOutputLength: CHUNK_BYTES }) : stored;
      if (raw.length !== chunk.raw_bytes || !digest(raw).equals(chunk.hash)) throw new Error('Chunk checksum mismatch');
      return raw;
    } catch (error) {
      throw new PlatformStorageError('CORRUPT_DATA', `Cannot read content chunk: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
