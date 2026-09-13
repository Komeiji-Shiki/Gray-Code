import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { openPromise } from 'yauzl';
import type { BackupFile, BackupManifest } from '@graycode/contracts';

const metadataLimit = 64 * 1024 * 1024;
const deriveKey = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));

function memberPath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\\') || value.split('/').some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('备份包含无效的文件路径。');
  return value;
}

async function* encrypt(source: AsyncIterable<Buffer>, key: Buffer, name: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(name));
  yield nonce;
  for await (const chunk of source) yield cipher.update(chunk);
  yield cipher.final();
  yield cipher.getAuthTag();
}

async function* decrypt(source: AsyncIterable<Buffer>, key: Buffer, name: string) {
  let pending = Buffer.alloc(0);
  let cipher: ReturnType<typeof createDecipheriv> | undefined;
  try {
    for await (const chunk of source) {
      pending = Buffer.concat([pending, chunk]);
      if (!cipher && pending.length >= 12) {
        const value = createDecipheriv('aes-256-gcm', key, pending.subarray(0, 12));
        value.setAAD(Buffer.from(name)); cipher = value; pending = pending.subarray(12);
      }
      if (cipher && pending.length > 16) {
        yield cipher.update(pending.subarray(0, -16)); pending = pending.subarray(-16);
      }
    }
    if (!cipher || pending.length !== 16) throw new Error('加密内容不完整。');
    (cipher as ReturnType<typeof createDecipheriv> & { setAuthTag(value: Buffer): void }).setAuthTag(pending);
    yield cipher.final();
  } catch (error) {
    throw new Error(`备份密码不正确，或加密文件已经损坏：${name}`, { cause: error });
  }
}

async function buffer(source: AsyncIterable<Buffer>, limit = metadataLimit): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of source) {
    length += chunk.length;
    if (length > limit) throw new Error('备份清单超过支持的大小。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 每次只读取一个文件；大附件不转成 Base64，也不要求把整个压缩包放进内存。 */
export async function writeBackupArchive(options: {
  directory: string; destination: string; manifest: Omit<BackupManifest, 'files'>;
  password?: string; credentials?: Record<string, string>; signal: AbortSignal;
  progress(bytes: number, total: number, file: string): void;
}): Promise<BackupManifest> {
  const files: BackupFile[] = [];
  const sources = new Map<string, { filename?: string; bytes?: Buffer; mtimeMs?: number }>();
  async function visit(relative: string) {
    for (const entry of await fs.readdir(path.join(options.directory, relative), { withFileTypes: true })) {
      options.signal.throwIfAborted();
      const name = memberPath(relative ? `${relative}/${entry.name}` : entry.name);
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) throw new Error(`备份不支持这个资源类型：${name}`);
      const filename = path.join(options.directory, name), info = await fs.stat(filename);
      files.push({ path: `data/${name}`, bytes: info.size, mode: info.mode & 0o777, sha256: '' });
      sources.set(`data/${name}`, { filename, mtimeMs: info.mtimeMs });
    }
  }
  await visit('');
  const salt = options.password ? randomBytes(16) : undefined;
  const key = salt ? await deriveKey(options.password!, salt) : undefined;
  if (options.credentials) {
    if (!key) throw new Error('跨设备密钥备份需要设置备份密码。');
    const bytes = Buffer.from(JSON.stringify(options.credentials));
    files.push({ path: 'credentials.json', bytes: bytes.length, mode: 0o600, sha256: '' });
    sources.set('credentials.json', { bytes });
  }
  const manifest: BackupManifest = { ...options.manifest, files };
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  let processed = 0;
  const archive = new ZipFile();
  const streams: Readable[] = [];
  const destination = createWriteStream(options.destination, { flags: 'wx', mode: 0o600 });
  archive.on('error', (error: Error) => archive.outputStream.destroy(error));
  const written = pipeline(archive.outputStream, destination, { signal: options.signal });
  // 等待方在文件列表准备完毕后才接收异常，先标记已处理以避免流失败成为未处理拒绝。
  void written.catch(() => {});
  if (salt) archive.addBuffer(Buffer.from(JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64') })), 'encryption.json');
  for (const file of files) {
    const source = sources.get(file.path)!;
    async function* content() {
      const hash = createHash('sha256'); let readBytes = 0;
      const stream = source.bytes ? Readable.from([source.bytes]) : createReadStream(source.filename!, { signal: options.signal });
      for await (const chunk of stream) {
        options.signal.throwIfAborted(); const bytes = chunk as Buffer;
        readBytes += bytes.length; processed += bytes.length; hash.update(bytes);
        options.progress(processed, total, file.path); yield bytes;
      }
      if (readBytes !== file.bytes || source.filename && (await fs.stat(source.filename)).mtimeMs !== source.mtimeMs)
        throw new Error(`打包期间资源发生变化：${file.path}`);
      file.sha256 = hash.digest('hex');
    }
    const stream = Readable.from(key ? encrypt(content(), key, file.path) : content());
    streams.push(stream);
    stream.on('error', (error: Error) => archive.outputStream.destroy(error));
    archive.addReadStream(stream, file.path, { size: file.bytes + (key ? 28 : 0), mode: 0o100000 | file.mode,
      compress: !key && !file.path.endsWith('.bin') });
  }
  // 清单最后写入；此前各条目已顺序完成散列计算，不必额外读取一遍大附件。
  const manifestStream = Readable.from((async function* () {
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (key) yield* encrypt(Readable.from([bytes]), key, 'manifest.json');
    else yield bytes;
  })());
  manifestStream.on('error', (error: Error) => archive.outputStream.destroy(error));
  archive.addReadStream(manifestStream, 'manifest.json', { compress: !key });
  streams.push(manifestStream);
  archive.end();
  try {
    await written;
    const file = await fs.open(options.destination, 'r+');
    try { await file.sync(); } finally { await file.close(); }
    return manifest;
  } finally { for (const stream of streams) stream.destroy(); key?.fill(0); }
}

export async function extractBackupArchive(options: {
  source: string; directory: string; password?: string; signal: AbortSignal;
  progress(bytes: number, total: number, file: string): void;
}): Promise<{ manifest: BackupManifest; credentials?: Record<string, string> }> {
  const archive = await openPromise(options.source, { autoClose: false, strictFileNames: true });
  let key: Buffer | undefined;
  try {
    const entries = new Map<string, any>(); const names = new Set<string>();
    for await (const entry of archive.eachEntry()) {
      options.signal.throwIfAborted();
      const name = memberPath(entry.fileName);
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (kind && kind !== 0o100000 || names.has(name.toLowerCase())) throw new Error(`备份包含重复路径或非普通文件：${name}`);
      names.add(name.toLowerCase()); entries.set(name, entry);
    }
    async function readMetadata(name: string, encrypted = true) {
      const entry = entries.get(name);
      if (!entry || entry.uncompressedSize > metadataLimit + 28) throw new Error(`备份缺少有效的 ${name}。`);
      const stream = await archive.openReadStreamPromise(entry);
      return JSON.parse((await buffer(encrypted && key ? decrypt(stream, key, name) : stream)).toString('utf8'));
    }
    if (entries.has('encryption.json')) {
      const encryption = await readMetadata('encryption.json', false);
      const salt = typeof encryption.salt === 'string' ? Buffer.from(encryption.salt, 'base64') : Buffer.alloc(0);
      if (encryption.version !== 1 || encryption.algorithm !== 'aes-256-gcm' || encryption.kdf !== 'scrypt' || salt.length !== 16)
        throw new Error('不支持这个备份的加密格式。');
      if (!options.password) throw new Error('这个备份已加密，请输入备份密码。');
      key = await deriveKey(options.password, salt);
    }
    const manifest = await readMetadata('manifest.json') as BackupManifest;
    if (manifest?.format !== 'graycode-backup' || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) ||
      !Number.isFinite(manifest.createdAt) || !Number.isSafeInteger(manifest.schemaVersion) || typeof manifest.sourceDirectory !== 'string' ||
      manifest.credentials !== (key ? 'password' : 'device')) throw new Error('备份清单格式无效或版本不受支持。');
    const expected = new Set(['manifest.json', ...(key ? ['encryption.json'] : [])]);
    let total = 0;
    for (const file of manifest.files) {
      const name = memberPath(file.path);
      if ((!name.startsWith('data/') && !(name === 'credentials.json' && key)) || expected.has(name) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        entries.get(name)?.uncompressedSize !== file.bytes + (key ? 28 : 0)) throw new Error(`备份文件与清单不一致：${name}`);
      expected.add(name); total += file.bytes;
    }
    if (!expected.has('data/platform.sqlite') || entries.size !== expected.size || [...entries.keys()].some(name => !expected.has(name)))
      throw new Error('备份文件不完整，或包含清单之外的文件。');
    let processed = 0; let credentials: Record<string, string> | undefined;
    for (const file of manifest.files) {
      options.signal.throwIfAborted();
      const source = await archive.openReadStreamPromise(entries.get(file.path));
      const content = key ? Readable.from(decrypt(source, key, file.path)) : source;
      const hash = createHash('sha256'); let bytes = 0;
      const check = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length; processed += chunk.length; hash.update(chunk);
        options.progress(processed, total, file.path); done(null, chunk);
      } });
      if (file.path === 'credentials.json') {
        const value = await buffer(content, metadataLimit);
        bytes = value.length; hash.update(value);
        credentials = JSON.parse(value.toString('utf8'));
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
          Object.values(credentials).some(value => typeof value !== 'string')) throw new Error('备份密钥格式无效。');
      } else {
        const target = path.join(options.directory, file.path.slice('data/'.length));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await pipeline(content, check, createWriteStream(target, { flags: 'wx', mode: file.mode }), { signal: options.signal });
        await fs.chmod(target, file.mode);
      }
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`备份校验失败：${file.path}`);
    }
    return { manifest, credentials };
  } finally { key?.fill(0); archive.close(); }
}
