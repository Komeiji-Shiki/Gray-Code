import { createHash, randomUUID } from 'node:crypto';
import type { CharacterResource, CharacterResourceKind, RecordMutation } from '@graycode/contracts';
import { identifyCharacterResource, readCharacterDefinition, readCharacterFile, readRegexRules, readWorldbook } from '@graycode/core';
import type { PlatformApplication } from '../application';

export type ResourceInfo = Omit<CharacterResource, 'raw' | 'source'> & {
  source: Omit<CharacterResource['source'], 'inlineData'> & { mimeType: string };
  archived?: boolean;
  resolvedReferences?: Record<string, string>;
};
const metadataNamespace = 'character-resource-info';
const contentNamespace = 'character-resource-content';
const originalNamespace = 'character-resource-original';
type ResourceDefinition = Omit<CharacterResource, 'source'> & { source: ResourceInfo['source'] };

/** 资源元数据与原始正文分开存储，列表不读取整张 PNG。 */
export class CharacterResources {
  constructor(private readonly app: PlatformApplication) {}
  async list() {
    const ids = await this.app.storage.listRecords(metadataNamespace);
    const rows = await Promise.all(ids.map(async id => {
      const record = await this.app.storage.getVersionedRecord(metadataNamespace, id);
      return record.value ? { ...(record.value as ResourceInfo), revision: record.revision } : null;
    }));
    return rows.filter(row => row && !row.archived);
  }
  async get(id: string) {
    const record = await this.app.storage.getVersionedRecord(contentNamespace, id);
    if (!record.value) throw new Error('角色资源不存在。');
    const data = record.value as { raw: CharacterResource['raw']; info: ResourceInfo };
    const info = data.info;
    return { resource: { ...info, raw: data.raw, source: info.source } as ResourceDefinition,
      revision: record.revision, info };
  }
  async original(id: string) {
    const original = await this.app.storage.getRecord(originalNamespace, id) as CharacterResource['source'] | null;
    if (!original) throw new Error('原始资源文件不存在。');
    return original;
  }
  async definition(id: string) { return readCharacterDefinition((await this.get(id)).resource.raw); }
  private async write(info: ResourceInfo, resource: ResourceDefinition, revision: number | null) {
    await this.app.storage.commitRecords([
      { namespace: metadataNamespace, id: info.id, expectedRevision: revision, value: info },
      { namespace: contentNamespace, id: info.id, expectedRevision: revision,
        value: { info, raw: resource.raw } },
    ]);
  }
  async import(input: { name: string; data: string }) {
    const bytes = Buffer.from(input.data, 'base64');
    const parsed = readCharacterFile(bytes);
    const kind = identifyCharacterResource(parsed.raw);
    const resources: CharacterResource[] = [];
    const make = (raw: CharacterResource['raw'], resourceKind: CharacterResourceKind, name: string, sourceBytes: Buffer, mimeType: string) => {
      if (resourceKind === 'regex') readRegexRules(raw);
      if (resourceKind === 'worldbook') readWorldbook(raw, 'import');
      const resource: CharacterResource = { id: randomUUID(), kind: resourceKind, name, raw, createdAt: Date.now(), updatedAt: Date.now(),
        source: { name, sha256: createHash('sha256').update(sourceBytes).digest('hex'), inlineData: { mimeType, data: sourceBytes.toString('base64') } },
        warnings: [], bindings: { worldbookIds: [], regexIds: [], missing: [] } };
      resources.push(resource); return resource;
    };
    const primary = make(parsed.raw, kind, String(input.name), bytes, parsed.mimeType);
    if (kind === 'character') {
      const definition = readCharacterDefinition(parsed.raw);
      primary.name = definition.name;
      primary.bindings.missing = definition.missingReferences;
      if (definition.book) {
        const name = `${definition.name} · 内嵌世界书`;
        const book = make(definition.book, 'worldbook', name, Buffer.from(JSON.stringify(definition.book)), 'application/json');
        primary.bindings.worldbookIds.push(book.id);
      }
      if (definition.regexScripts.length) {
        const name = `${definition.name} · 随卡正则`;
        const regex = make(definition.regexScripts, 'regex', name, Buffer.from(JSON.stringify(definition.regexScripts)), 'application/json');
        primary.bindings.regexIds.push(regex.id);
      }
      if (definition.missingReferences.length) primary.warnings.push('卡片引用了外部世界书，请在资料绑定中明确选择。');
    }
    const mutations: RecordMutation[] = resources.flatMap(resource => {
      const { raw, source, ...info } = resource;
      const { inlineData, ...origin } = source;
      return [{ namespace: metadataNamespace, id: resource.id, expectedRevision: null,
        value: { ...info, source: { ...origin, mimeType: inlineData.mimeType } } },
      { namespace: contentNamespace, id: resource.id, expectedRevision: null, value: { raw, info: { ...info, source: { ...origin, mimeType: inlineData.mimeType } } } },
      { namespace: originalNamespace, id: resource.id, expectedRevision: null, value: source }];
    });
    await this.app.storage.commitRecords(mutations);
    return { id: primary.id, imported: resources.map(({ id, name, kind }) => ({ id, name, kind })) };
  }
  async bind(id: string, revision: number, input: { name: string; worldbookIds: string[]; regexIds: string[]; resolvedReferences?: Record<string, string> }) {
    const current = await this.get(id);
    const name = input.name.trim();
    if (!name) throw new Error('请填写资料名称。');
    const references = input.resolvedReferences ?? {};
    const worldbookIds = [...new Set([...input.worldbookIds, ...Object.values(references).filter(Boolean)])];
    const regexIds = [...new Set(input.regexIds)];
    await this.validateBindings(worldbookIds, regexIds);
    const originalMissing = current.resource.kind === 'character' ? readCharacterDefinition(current.resource.raw).missingReferences : [];
    const value: ResourceInfo = { ...current.info, name, updatedAt: Date.now(), resolvedReferences: references,
      bindings: { worldbookIds, regexIds, missing: originalMissing.filter(name => !references[name]) } };
    await this.write(value, current.resource, revision);
    return this.get(id);
  }
  async validateBindings(worldbookIds: string[], regexIds: string[]) {
    if (!Array.isArray(worldbookIds) || !Array.isArray(regexIds)) throw new Error('请选择资料列表。');
    for (const [kind, ids] of [['worldbook', worldbookIds], ['regex', regexIds]] as const) {
      for (const id of ids) {
        const value = await this.app.storage.getRecord(metadataNamespace, id) as ResourceInfo | null;
        if (!value || value.kind !== kind) throw new Error(`绑定的${kind === 'worldbook' ? '世界书' : '正则'}不存在。`);
      }
    }
  }
  async updateWorldbook(id: string, revision: number, raw: CharacterResource['raw'], name?: string) {
    const current = await this.get(id);
    if (current.resource.kind !== 'worldbook') throw new Error('请选择世界书资料。');
    if (!Array.isArray(raw) && (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object')) throw new Error('世界书定义必须包含 entries。');
    readWorldbook(raw, id);
    if (name !== undefined && !name.trim()) throw new Error('请填写资料名称。');
    await this.write({ ...current.info, name: name?.trim() ?? current.info.name, updatedAt: Date.now() }, { ...current.resource, raw }, revision);
    return this.get(id);
  }
  async archive(id: string, revision: number) {
    const current = await this.get(id);
    await this.write({ ...current.info, archived: true, updatedAt: Date.now() }, current.resource, revision);
  }
}
