import { attribute, element, nodes, OfficeArchive, relatedPart, textValue, type OfficeFormat, type XmlNode, type XmlTree } from './archive';

export interface OfficeParagraph { target: string; part: string; text: string; slide?: number; notes?: boolean; style?: string }
export interface ParagraphEdit { target: string; text: string }

function paragraphText(tree: XmlTree, prefix: 'w' | 'a'): string {
  return tree.map(node => Object.entries(node).filter(([key]) => key !== ':@').map(([key, value]) => {
    if (key === `${prefix}:p`) return '';
    if (key === `${prefix}:t`) return textValue(value);
    if (key === `${prefix}:tab`) return '\t';
    if (key === `${prefix}:br`) return '\n';
    return Array.isArray(value) ? paragraphText(value, prefix) : '';
  }).join('')).join('');
}

export function slideParts(archive: OfficeArchive): string[] {
  const relations = nodes(archive.read('ppt/_rels/presentation.xml.rels'), 'Relationship');
  const byId = new Map(relations.map(node => [attribute(node, 'Id'), attribute(node, 'Target')]));
  return nodes(archive.read('ppt/presentation.xml'), 'p:sldId').map(node => {
    const target = byId.get(attribute(node, 'r:id'));
    if (!target) throw new Error('幻灯片关系缺失。');
    const part = relatedPart('ppt/presentation.xml', target);
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(part)) throw new Error('幻灯片路径无效。');
    return part;
  });
}

export function readParagraphs(archive: OfficeArchive, format: Exclude<OfficeFormat, 'xlsx'>): OfficeParagraph[] {
  const parts: Array<{ part: string; slide?: number; notes?: boolean }> = format === 'docx'
    ? archive.names().filter(name => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name))
      .sort((left, right) => left === 'word/document.xml' ? -1 : right === 'word/document.xml' ? 1 : left.localeCompare(right))
      .map(part => ({ part }))
    : slideParts(archive).flatMap((part, index) => {
      const found: Array<{ part: string; slide: number; notes?: boolean }> = [{ part, slide: index + 1 }];
      const relationships = part.replace(/([^/]+)$/, '_rels/$1.rels');
      if (archive.zip.getEntry(relationships)) for (const relation of nodes(archive.read(relationships), 'Relationship')) {
        if (!attribute(relation, 'Type')?.endsWith('/notesSlide')) continue;
        const target = attribute(relation, 'Target');
        if (!target || attribute(relation, 'TargetMode') === 'External') throw new Error('幻灯片备注关系无效。');
        const notes = relatedPart(part, target);
        if (!/^ppt\/notesSlides\/[^/]+\.xml$/.test(notes)) throw new Error('幻灯片备注路径无效。');
        found.push({ part: notes, slide: index + 1, notes: true });
      }
      return found;
    });
  const prefix = format === 'docx' ? 'w' : 'a';
  return parts.flatMap(({ part, slide, notes: isNotes }) => nodes(archive.read(part), `${prefix}:p`).map((node, index) => ({
    target: `${part}#${index}`, part, text: paragraphText(node[`${prefix}:p`], prefix),
    ...(slide === undefined ? {} : { slide, ...(isNotes ? { notes: true } : {}) }),
    ...(format === 'docx' ? { style: attribute(nodes(node['w:p'], 'w:pStyle')[0] ?? {}, 'w:val') } : {}),
  })));
}

/** 修改一个段落的文字，沿用首个文字运行的格式，保留图像和其他非文字节点。 */
function replaceParagraph(node: XmlNode, prefix: 'w' | 'a', text: string): void {
  const tag = `${prefix}:p`, runTag = `${prefix}:r`, textTag = `${prefix}:t`;
  const contents: XmlTree = node[tag];
  if (prefix === 'w' && (nodes(contents, 'w:instrText').length || nodes(contents, 'w:fldSimple').length))
    throw new Error('此段落包含自动字段，请修改普通段落或在 Word 中编辑该字段。');
  let first: { parent: XmlTree; node: XmlNode; properties: XmlTree } | undefined;
  const clean = (tree: XmlTree) => {
    for (let index = tree.length - 1; index >= 0; index--) {
      const child = tree[index];
      for (const [key, value] of Object.entries(child)) {
        if (key === tag) continue;
        if (key === textTag || key === `${prefix}:tab` || key === `${prefix}:br`) { tree.splice(index, 1); break; }
        if (key !== ':@' && Array.isArray(value)) clean(value);
      }
    }
  };
  const find = (tree: XmlTree) => {
    for (const child of tree) for (const [key, value] of Object.entries(child)) {
      if (key === tag) continue;
      if (!first && key === runTag && value.some((entry: XmlNode) => textTag in entry)) first = { parent: tree, node: child,
        properties: value.filter((entry: XmlNode) => `${prefix}:rPr` in entry) };
      if (key !== ':@' && Array.isArray(value)) find(value);
    }
  };
  find(contents); clean(contents);
  const properties = first?.properties ?? [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const runs: XmlTree = [];
  const words = (line: string) => line.split('\t').flatMap((piece, index) => [
    ...(index ? [element('w:tab')] : []), element(textTag, [{ '#text': piece }], { 'xml:space': 'preserve' }),
  ]);
  if (prefix === 'w') runs.push(element(runTag, [...structuredClone(properties), ...lines.flatMap((line, index) => [
    ...(index ? [element('w:br')] : []), ...words(line),
  ])]));
  else for (const [index, line] of lines.entries()) {
    if (index) runs.push(element('a:br'));
    runs.push(element(runTag, [...structuredClone(properties), element('a:t', [{ '#text': line }])]));
  }
  if (first) first.parent.splice(first.parent.indexOf(first.node), 0, ...runs);
  else {
    const end = contents.findIndex(child => 'a:endParaRPr' in child);
    contents.splice(end < 0 ? contents.length : end, 0, ...runs);
  }
  // DrawingML 的文字运行必须保留 a:t；被替换的空运行仍保留原有格式节点。
  if (prefix === 'a') for (const run of nodes(contents, 'a:r')) if (!run['a:r'].some((child: XmlNode) => 'a:t' in child))
    run['a:r'].push(element('a:t', [{ '#text': '' }]));
}

export function editParagraphs(archive: OfficeArchive, format: Exclude<OfficeFormat, 'xlsx'>,
  changes: ParagraphEdit[], append: string[] = []): void {
  const prefix = format === 'docx' ? 'w' : 'a';
  const allowed = new Set(readParagraphs(archive, format).map(item => item.target));
  const edited = new Set<string>(), parts = new Map<string, XmlTree>();
  for (const change of changes) {
    if (!allowed.has(change.target) || edited.has(change.target)) throw new Error(`段落定位无效或重复：${change.target}`);
    const separator = change.target.lastIndexOf('#'), part = change.target.slice(0, separator);
    const tree = parts.get(part) ?? archive.read(part); parts.set(part, tree); edited.add(change.target);
    replaceParagraph(nodes(tree, `${prefix}:p`)[Number(change.target.slice(separator + 1))], prefix, change.text);
  }
  if (append.length) {
    if (format !== 'docx') throw new Error('appendParagraphs 只用于 Word 文档。');
    const tree = parts.get('word/document.xml') ?? archive.read('word/document.xml'); parts.set('word/document.xml', tree);
    const body: XmlTree = nodes(tree, 'w:body')[0]['w:body'];
    let index = body.findIndex(node => 'w:sectPr' in node); if (index < 0) index = body.length;
    const paragraphs = append.map(text => { const node = element('w:p'); replaceParagraph(node, 'w', text); return node; });
    body.splice(index, 0, ...paragraphs);
  }
  for (const [part, tree] of parts) archive.write(part, tree);
}
