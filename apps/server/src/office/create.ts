import type { CellValue } from 'exceljs';
import { MAX_OFFICE_BYTES, type OfficeFormat } from './archive';

export type OfficeCellValue = string | number | boolean | null | { formula: string; result?: string | number | boolean };
export interface OfficeCell { sheet?: string; address: string; value: OfficeCellValue; numFmt?: string; bold?: boolean }
export interface OfficeContent {
  title?: string;
  font?: string;
  blocks?: Array<{ type: 'paragraph' | 'heading' | 'table'; text?: string; level?: number; rows?: string[][];
    bold?: boolean; italic?: boolean; fontSize?: number; alignment?: 'left' | 'center' | 'right' | 'justify' }>;
  sheets?: Array<{ name: string; rows?: OfficeCellValue[][]; cells?: OfficeCell[]; columnWidths?: number[]; merges?: string[] }>;
  slides?: Array<{ title?: string; text?: string; notes?: string;
    elements?: Array<{ text: string; x: number; y: number; w: number; h: number; fontSize?: number; bold?: boolean; color?: string }>; }>;
}

async function createWord(content: OfficeContent): Promise<Buffer> {
  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx');
  if (!content.blocks?.length) throw new Error('Word 文档需要 blocks。');
  const alignments = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
  const children = content.blocks.map(block => {
    if (block.type === 'table') {
      if (!block.rows?.length || block.rows.some(row => !row.length)) throw new Error('Word 表格需要非空 rows。');
      return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map(row => new TableRow({
        children: row.map(text => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, font: content.font })] })] })),
      })) });
    }
    if (typeof block.text !== 'string') throw new Error('Word 段落需要 text。');
    const heading = block.type === 'heading' ? HeadingLevel[`HEADING_${block.level ?? 1}` as keyof typeof HeadingLevel] : undefined;
    const lines = block.text.replace(/\r\n?/g, '\n').split('\n');
    return new Paragraph({ heading, alignment: block.alignment ? alignments[block.alignment] : undefined,
      children: lines.map((text, index) => new TextRun({ text, break: index ? 1 : undefined, font: content.font,
        bold: block.bold, italics: block.italic, size: block.fontSize === undefined ? undefined : block.fontSize * 2 })) });
  });
  return Packer.toBuffer(new Document({ title: content.title, creator: 'GrayCode', sections: [{ children }] }));
}

export function cellValue(value: OfficeCellValue): CellValue {
  if (value && typeof value === 'object') return { formula: value.formula.replace(/^=/, ''),
    ...(value.result === undefined ? {} : { result: value.result }) };
  return value;
}

async function createSpreadsheet(content: OfficeContent): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  if (!content.sheets?.length) throw new Error('Excel 工作簿需要 sheets。');
  const book = new ExcelJS.Workbook(); book.creator = 'GrayCode'; book.title = content.title ?? '';
  book.calcProperties.fullCalcOnLoad = true;
  const names = new Set<string>();
  for (const definition of content.sheets) {
    if (names.has(definition.name.toLowerCase())) throw new Error(`工作表名称重复：${definition.name}`);
    names.add(definition.name.toLowerCase());
    const sheet = book.addWorksheet(definition.name);
    for (const row of definition.rows ?? []) sheet.addRow(row.map(cellValue));
    for (const [index, width] of (definition.columnWidths ?? []).entries()) sheet.getColumn(index + 1).width = width;
    for (const range of definition.merges ?? []) sheet.mergeCells(range);
    for (const definitionCell of definition.cells ?? []) {
      const cell = sheet.getCell(definitionCell.address.toUpperCase()); cell.value = cellValue(definitionCell.value);
      if (definitionCell.numFmt !== undefined) cell.numFmt = definitionCell.numFmt;
      if (definitionCell.bold !== undefined) cell.font = { ...cell.font, bold: definitionCell.bold };
    }
    if (content.font) sheet.eachRow(row => row.eachCell(cell => { cell.font = { ...cell.font, name: content.font }; }));
  }
  // ExcelJS 的 Node 实现返回 Buffer，声明文件仍将它写成 ArrayBuffer。
  return await book.xlsx.writeBuffer() as unknown as Buffer;
}

async function createSlides(content: OfficeContent): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  if (!content.slides?.length) throw new Error('PPT 演示文稿需要 slides。');
  const presentation = new PptxGenJS(); presentation.layout = 'LAYOUT_WIDE'; presentation.author = 'GrayCode';
  if (content.title !== undefined) presentation.title = content.title;
  for (const definition of content.slides) {
    const slide = presentation.addSlide();
    if (definition.title !== undefined) slide.addText(definition.title, { x: 0.6, y: 0.4, w: 12.1, h: 0.7,
      fontFace: content.font, fontSize: 30, bold: true, breakLine: false });
    if (definition.text !== undefined) slide.addText(definition.text, { x: 0.6, y: 1.4, w: 12.1, h: 5.3,
      fontFace: content.font, fontSize: 20, valign: 'top' });
    for (const item of definition.elements ?? []) slide.addText(item.text, { ...item, fontFace: content.font });
    if (definition.notes !== undefined) slide.addNotes(definition.notes);
  }
  return await presentation.write({ outputType: 'nodebuffer', compression: true }) as Buffer;
}

export async function createOffice(format: OfficeFormat, content: OfficeContent): Promise<Buffer> {
  if (format === 'docx' && (content.sheets || content.slides) || format === 'xlsx' && (content.blocks || content.slides)
    || format === 'pptx' && (content.blocks || content.sheets)) throw new Error('content 的结构必须与文件后缀对应。');
  const bytes = await (format === 'docx' ? createWord(content) : format === 'xlsx' ? createSpreadsheet(content) : createSlides(content));
  if (bytes.length > MAX_OFFICE_BYTES) throw new Error('生成的 Office 文件超过 64 MiB。');
  return bytes;
}
