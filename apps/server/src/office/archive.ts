import AdmZip from 'adm-zip';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import path from 'node:path';
import { officeFormatFor, type OfficeFormat } from '../../../../shared/officeFormats';

export const MAX_OFFICE_BYTES = 64 * 1024 * 1024;
export type { OfficeFormat } from '../../../../shared/officeFormats';
export type XmlNode = Record<string, any>;
export type XmlTree = XmlNode[];

export function officeFormat(file: string): OfficeFormat {
  const extension = officeFormatFor(file);
  if (!extension)
    throw new Error('Office 工具支持 .docx、.xlsx、.pptx。旧版 .doc、.xls、.ppt 请先在 Office 中另存为对应的新格式。');
  return extension;
}

/** 局部编辑保留其他 ZIP 条目，避免重建文件时丢失图片、图表和版式资源。 */
export class OfficeArchive {
  readonly zip: AdmZip;
  constructor(bytes: Uint8Array, format: OfficeFormat) {
    if (bytes.length > MAX_OFFICE_BYTES) throw new Error('Office 文件超过 64 MiB。');
    this.zip = new AdmZip(Buffer.from(bytes));
    const entries = this.zip.getEntries();
    if (entries.length > 20000 || entries.reduce((sum: number, entry: any) => sum + entry.header.size, 0) > 256 * 1024 * 1024)
      throw new Error('Office 文件解压后的内容过大。');
    const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[format];
    if (!this.zip.getEntry(main) || !this.zip.getEntry('[Content_Types].xml')) throw new Error('文件不是有效的 Office Open XML 文档。');
  }
  names(): string[] { return this.zip.getEntries().filter((entry: any) => !entry.isDirectory).map((entry: any) => entry.entryName); }
  read(part: string): XmlTree {
    const entry = this.zip.getEntry(part);
    if (!entry) throw new Error(`文档中不存在这个部分：${part}`);
    const xml = entry.getData().toString('utf8');
    if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error(`Office XML 内容无效：${part}`);
    return new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false,
      parseAttributeValue: false }).parse(xml);
  }
  write(part: string, tree: XmlTree): void {
    this.zip.updateFile(part, Buffer.from(new XMLBuilder({ preserveOrder: true, ignoreAttributes: false,
      suppressEmptyNode: true }).build(tree)));
  }
  bytes(): Buffer {
    const bytes = this.zip.toBuffer();
    if (bytes.length > MAX_OFFICE_BYTES) throw new Error('生成的 Office 文件超过 64 MiB。');
    return bytes;
  }
}

export function nodes(tree: XmlTree, tag: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (children: XmlTree) => {
    for (const node of children) for (const [key, value] of Object.entries(node)) {
      if (key === tag) found.push(node);
      if (key !== ':@' && Array.isArray(value)) visit(value);
    }
  };
  visit(tree); return found;
}
export function element(tag: string, children: XmlTree = [], attributes?: Record<string, string>): XmlNode {
  return { [tag]: children, ...(attributes ? { ':@': Object.fromEntries(Object.entries(attributes).map(([key, value]) => [`@_${key}`, value])) } : {}) };
}
export function attribute(node: XmlNode, name: string): string | undefined { return node[':@']?.[`@_${name}`]; }
export function setAttribute(node: XmlNode, name: string, value: string): void { (node[':@'] ??= {})[`@_${name}`] = value; }
export function textValue(tree: XmlTree): string {
  return tree.map(node => Object.entries(node).filter(([key]) => key !== ':@').map(([key, value]) =>
    key === '#text' ? String(value) : Array.isArray(value) ? textValue(value) : '').join('')).join('');
}

export function relatedPart(base: string, target: string): string {
  const part = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(base), target));
  if (part.startsWith('../')) throw new Error('Office 资源关系超出了文档范围。');
  return part;
}
