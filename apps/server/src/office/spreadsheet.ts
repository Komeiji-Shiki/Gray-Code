import { attribute, element, nodes, OfficeArchive, relatedPart, setAttribute, type XmlNode, type XmlTree } from './archive';
import type { OfficeCell } from './create';

export async function readSpreadsheet(bytes: Uint8Array, selected?: string) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Uint8Array.from(bytes).buffer);
  const sheets = book.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }));
  if (selected && !book.getWorksheet(selected)) throw new Error(`工作表不存在：${selected}`);
  const items: Array<Record<string, unknown>> = [];
  for (const sheet of book.worksheets) {
    if (selected && sheet.name !== selected) continue;
    sheet.eachRow(row => row.eachCell(cell => {
      const formula = cell.formula;
      const saved = cell.value && typeof cell.value === 'object' && 'result' in cell.value ? cell.value.result : cell.value;
      const value = saved instanceof Date ? saved.toISOString()
        : saved && typeof saved === 'object' ? 'error' in saved ? saved.error : undefined : saved;
      items.push({ sheet: sheet.name, address: cell.address, value,
        text: formula ? `=${formula}\n${cell.text}` : cell.text, ...(formula ? { formula } : {}),
        ...(cell.numFmt ? { numFmt: cell.numFmt } : {}) });
    }));
  }
  return { sheets, items };
}

function coordinates(address: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
  if (!match) throw new Error(`单元格地址无效：${address}`);
  const column = [...match[1]].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0), row = Number(match[2]);
  if (row > 1048576 || column > 16384) throw new Error(`单元格地址超出了 Excel 范围：${address}`);
  return { row, column };
}

function sheetParts(archive: OfficeArchive): Map<string, string> {
  const relations = nodes(archive.read('xl/_rels/workbook.xml.rels'), 'Relationship');
  const byId = new Map(relations.map(node => [attribute(node, 'Id'), attribute(node, 'Target')]));
  return new Map(nodes(archive.read('xl/workbook.xml'), 'sheet').map(node => {
    const name = attribute(node, 'name'), target = byId.get(attribute(node, 'r:id'));
    if (!name || !target) throw new Error('工作表关系缺失。');
    const part = relatedPart('xl/workbook.xml', target);
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(part)) throw new Error('工作表路径无效。');
    return [name, part];
  }));
}

/** 只更新目标单元格 XML，保留工作簿中未被编辑的图表、图片、样式和其他资源。 */
export function editSpreadsheet(archive: OfficeArchive, changes: OfficeCell[]): void {
  const sheets = sheetParts(archive), parts = new Map<string, XmlTree>(), seen = new Set<string>();
  for (const change of changes) {
    if (!change.sheet || !sheets.has(change.sheet)) throw new Error(`工作表不存在：${change.sheet ?? ''}`);
    const address = change.address.toUpperCase(), { row, column } = coordinates(address);
    const key = `${change.sheet}!${address}`;
    if (seen.has(key)) throw new Error(`不能重复修改同一个单元格：${key}`);
    seen.add(key);
    const part = sheets.get(change.sheet)!, tree = parts.get(part) ?? archive.read(part); parts.set(part, tree);
    if (nodes(tree, 'sheetProtection').length) throw new Error(`工作表 ${change.sheet} 已受保护，请先在 Excel 中解除保护。`);
    const sheet = nodes(tree, 'worksheet')[0], children: XmlTree = sheet.worksheet;
    for (const merge of nodes(tree, 'mergeCell')) {
      const range = attribute(merge, 'ref')?.split(':');
      if (!range || range.length !== 2) continue;
      const start = coordinates(range[0]), end = coordinates(range[1]);
      if (row >= start.row && row <= end.row && column >= start.column && column <= end.column && address !== range[0])
        throw new Error(`${key} 位于合并单元格内，请修改左上角 ${range[0]}。`);
    }
    const data = children.find(node => 'sheetData' in node);
    if (!data) throw new Error('工作表缺少 sheetData。');
    let rowNode = data.sheetData.find((node: XmlNode) => attribute(node, 'r') === String(row));
    if (!rowNode) {
      rowNode = element('row', [], { r: String(row) });
      const index = data.sheetData.findIndex((node: XmlNode) => Number(attribute(node, 'r')) > row);
      data.sheetData.splice(index < 0 ? data.sheetData.length : index, 0, rowNode);
    }
    let cell = rowNode.row.find((node: XmlNode) => attribute(node, 'r') === address);
    if (!cell) {
      cell = element('c', [], { r: address });
      const index = rowNode.row.findIndex((node: XmlNode) => 'c' in node && coordinates(attribute(node, 'r')!).column > column);
      rowNode.row.splice(index < 0 ? rowNode.row.length : index, 0, cell);
    }
    const formula = cell.c.find((node: XmlNode) => 'f' in node);
    if (formula && ['shared', 'array', 'dataTable'].includes(attribute(formula, 't') ?? ''))
      throw new Error(`${key} 属于共享公式或数组公式，请在 Excel 中编辑整个公式区域。`);
    cell.c = cell.c.filter((node: XmlNode) => !('f' in node || 'v' in node || 'is' in node));
    delete cell[':@']?.['@_t'];
    const value = change.value;
    if (value && typeof value === 'object') {
      cell.c.push(element('f', [{ '#text': value.formula.replace(/^=/, '') }]));
    } else if (typeof value === 'string') {
      setAttribute(cell, 't', 'inlineStr');
      cell.c.push(element('is', [element('t', [{ '#text': value }], { 'xml:space': 'preserve' })]));
    } else if (value !== null) {
      if (typeof value === 'boolean') setAttribute(cell, 't', 'b');
      cell.c.push(element('v', [{ '#text': typeof value === 'boolean' ? value ? '1' : '0' : String(value) }]));
    }
  }
  // 单元格改变后旧公式缓存不再可信，交给外部 Excel/LibreOffice 打开时统一重算。
  for (const part of sheets.values()) {
    const tree = parts.get(part) ?? archive.read(part);
    let changed = parts.has(part);
    if (changed) {
      const dimension = nodes(tree, 'dimension')[0];
      if (dimension) {
        let maxRow = 1, maxColumn = 1, letters = 'A';
        for (const cell of nodes(tree, 'c')) {
          const address = attribute(cell, 'r')!, point = coordinates(address);
          maxRow = Math.max(maxRow, point.row);
          if (point.column > maxColumn) { maxColumn = point.column; letters = address.replace(/\d+$/, ''); }
        }
        setAttribute(dimension, 'ref', `A1:${letters}${maxRow}`);
      }
    }
    for (const cell of nodes(tree, 'c')) if (cell.c.some((node: XmlNode) => 'f' in node)) {
      cell.c = cell.c.filter((node: XmlNode) => !('v' in node)); changed = true;
    }
    if (changed) archive.write(part, tree);
  }
  const workbook = archive.read('xl/workbook.xml'), body: XmlTree = nodes(workbook, 'workbook')[0].workbook;
  let calc = body.find(node => 'calcPr' in node);
  if (!calc) { calc = element('calcPr'); body.push(calc); }
  for (const name of ['fullCalcOnLoad', 'forceFullCalc']) setAttribute(calc, name, '1');
  setAttribute(calc, 'calcMode', 'auto'); archive.write('xl/workbook.xml', workbook);
  if (archive.zip.getEntry('xl/calcChain.xml')) {
    archive.zip.deleteFile('xl/calcChain.xml');
    for (const [part, root, tag, key] of [
      ['xl/_rels/workbook.xml.rels', 'Relationships', 'Relationship', 'Type'],
      ['[Content_Types].xml', 'Types', 'Override', 'PartName'],
    ]) {
      const tree = archive.read(part), node = nodes(tree, root)[0];
      node[root] = node[root].filter((child: XmlNode) => !(tag in child) || !attribute(child, key)?.includes('calcChain'));
      archive.write(part, tree);
    }
  }
}
