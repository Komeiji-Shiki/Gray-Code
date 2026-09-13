import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { PetImport, PetResource, RecordMutation } from '@graycode/contracts';
import type { PlatformStorage } from '@graycode/core';
import { live2dReferences, petAnimations, petAssetPath } from '../../../../shared/petFormat';

const infoNamespace = 'pet-resource';
const fileNamespace = 'pet-resource-file';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mimeTypes: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json', moc3: 'application/octet-stream', wav: 'audio/wav', mp3: 'audio/mpeg' };
function json(bytes: Uint8Array, name: string): Record<string, any> {
  try { const value = JSON.parse(Buffer.from(bytes).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new Error(`${name} 不是有效的 JSON 对象。`); }
}
export class PetResources {
  constructor(private readonly storage: PlatformStorage) {}
  async list(): Promise<PetResource[]> {
    return (await Promise.all((await this.storage.listRecords(infoNamespace)).map(id => this.storage.getRecord(infoNamespace, id)))).filter(Boolean) as PetResource[];
  }
  async get(id: string): Promise<PetResource> {
    const info = await this.storage.getRecord(infoNamespace, id) as PetResource | null;
    if (!info) throw new Error('桌宠资源不存在。'); return info;
  }
  async file(id: string, name: string) {
    const info = await this.get(id); const meta = info.files.find(file => file.path === name);
    if (!meta) throw new Error('资源文件不存在。');
    const record = await this.storage.getRecord(fileNamespace, `${id}/${name}`) as { bytes: Uint8Array } | null;
    if (!record || hash(record.bytes) !== meta.sha256) throw new Error('资源文件缺失或校验不一致。');
    return { bytes: record.bytes, mimeType: meta.mimeType };
  }
  async bundle(id: string): Promise<PetImport> {
    const info = await this.get(id);
    return { entry: info.entry, name: info.name, source: info.source, license: info.license,
      files: await Promise.all(info.files.map(async file => ({ path: file.path, data: Buffer.from((await this.file(id, file.path)).bytes).toString('base64') }))) };
  }
  async import(input: PetImport) {
    if (!input || !Array.isArray(input.files) || !input.files.length || input.files.length > 2000) throw new Error('请选择桌宠资源目录中的清单及引用文件。');
    const entry = petAssetPath(input.entry); const uploaded = new Map<string, Buffer>(); let total = 0;
    for (const file of input.files) {
      const name = petAssetPath(file.path);
      if (uploaded.has(name)) throw new Error(`文件路径重复：${name}`);
      if (typeof file.data !== 'string' || file.data.length > 90 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error(`资源内容无效：${name}`);
      const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
      if (total > 128 * 1024 * 1024) throw new Error('一次导入的资源总量不能超过 128 MiB。');
      uploaded.set(name, bytes);
    }
    const take = (name: string) => { const bytes = uploaded.get(name); if (!bytes) throw new Error(`缺少引用文件：${name}`); return bytes; };
    const raw = json(take(entry), entry); const selected = new Set([entry]);
    const now = Date.now();
    const info: PetResource = { id: randomUUID(), kind: raw.spritesheetPath ? 'sprite' : 'live2d', name: String(input.name || raw.displayName || entry.split('/').at(-1)).trim().slice(0, 120),
      description: String(raw.description ?? '').slice(0, 4000), entry, source: String(input.source ?? '').slice(0, 4000), license: String(input.license ?? '').slice(0, 8000), sha256: '', createdAt: now, files: [], actions: [], expressions: [] };
    if (info.kind === 'sprite') {
      const version = raw.spriteVersionNumber ?? 1;
      if (version !== 1 && version !== 2) throw new Error('目前支持 Codex 桌宠清单版本 1 和 2。');
      const atlas = petAssetPath(entry, raw.spritesheetPath); selected.add(atlas);
      const bytes = take(atlas); const height = version === 2 ? 2288 : 1872;
      const decoded = sharp(bytes, { limitInputPixels: 1536 * 2288, failOn: 'error' }); const metadata = await decoded.metadata();
      if (!['png', 'webp'].includes(metadata.format ?? '') || metadata.width !== 1536 || metadata.height !== height || !metadata.hasAlpha || (metadata.pages ?? 1) !== 1) throw new Error(`版本 ${version} 图集需要透明 PNG/WebP，尺寸为 1536 × ${height}，且不能是动画图片。`);
      const pixels = await decoded.toColourspace('srgb').ensureAlpha().raw().toBuffer();
      const occupied = (row: number, column: number) => {
        for (let y = row * 208; y < (row + 1) * 208; y++) for (let x = column * 192; x < (column + 1) * 192; x++) if (pixels[(y * 1536 + x) * 4 + 3]! > 0) return true;
        return false;
      };
      for (let row = 0; row < height / 208; row++) for (let col = 0; col < 8; col++) {
        const required = row >= 9 || col < petAnimations[row]!.frames || version === 2 && row === 0 && col === 6;
        if (required && !occupied(row, col)) throw new Error(`图集第 ${row + 1} 行、第 ${col + 1} 格没有图像。`);
        if (!required && !(row === 0 && col === 6) && occupied(row, col)) throw new Error(`图集未使用的第 ${row + 1} 行、第 ${col + 1} 格应当透明。`);
      }
      info.sprite = { version, atlas, width: 1536, height, neutral: occupied(0, 6) };
      info.actions = petAnimations.map(action => ({ id: action.id, name: action.name, durationMs: action.frames * 125 }));
    } else {
      for (const reference of live2dReferences(raw)) { const name = petAssetPath(entry, reference); take(name); selected.add(name); }
      const moc = take(petAssetPath(entry, raw.FileReferences.Moc));
      if (moc.subarray(0, 4).toString('ascii') !== 'MOC3') throw new Error('模型的 moc3 文件头无效。');
      for (const texture of raw.FileReferences.Textures) {
        const metadata = await sharp(take(petAssetPath(entry, texture)), { limitInputPixels: 64 * 1024 * 1024 }).metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('Live2D 纹理格式不支持。');
      }
      for (const [group, motions] of Object.entries(raw.FileReferences.Motions ?? {}) as [string, Record<string, any>[]][]) {
        motions.forEach((motion, index) => {
          const definition = json(take(petAssetPath(entry, motion.File)), motion.File);
          if (definition.Version !== 3 || !Array.isArray(definition.Curves)) throw new Error(`动作文件无效：${motion.File}`);
          const seconds = definition.Meta?.Duration;
          info.actions.push({ id: `${group}/${index}`, name: `${group} · ${motion.File.split('/').at(-1)}`, group, index,
            ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? { durationMs: Math.round(seconds * 1000) } : {}) });
        });
      }
      for (const expression of raw.FileReferences.Expressions ?? []) {
        if (typeof expression.Name !== 'string' || info.expressions.some(item => item.id === expression.Name)) throw new Error('模型表情名称无效或重复。');
        const definition = json(take(petAssetPath(entry, expression.File)), expression.File);
        if (!Array.isArray(definition.Parameters)) throw new Error(`表情文件无效：${expression.File}`);
        info.expressions.push({ id: expression.Name, name: expression.Name });
      }
    }
    info.files = [...selected].sort().map(name => { const bytes = take(name); return { path: name, bytes: bytes.length, sha256: hash(bytes), mimeType: mimeTypes[name.split('.').at(-1)!.toLowerCase()] ?? 'application/octet-stream' }; });
    info.sha256 = hash(Buffer.from(JSON.stringify(info.files)));
    const records: RecordMutation[] = info.files.map(file => ({ namespace: fileNamespace, id: `${info.id}/${file.path}`, expectedRevision: null, value: { bytes: new Uint8Array(take(file.path)) } }));
    records.push({ namespace: infoNamespace, id: info.id, expectedRevision: null, value: info });
    await this.storage.commitRecords(records); return info;
  }
  async remove(id: string) {
    const info = await this.get(id);
    await this.storage.commitRecords([{ namespace: infoNamespace, id, delete: true }, ...info.files.map(file => ({ namespace: fileNamespace, id: `${id}/${file.path}`, delete: true as const }))]);
  }
}
