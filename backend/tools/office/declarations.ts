import type { ToolDeclaration } from '@graycode/contracts';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';

const cellValueSchema = { anyOf: [
  { type: ['string', 'number', 'boolean', 'null'] },
  { type: 'object', additionalProperties: false, properties: {
    formula: { type: 'string', minLength: 1 }, result: { type: ['string', 'number', 'boolean'] },
  }, required: ['formula'] },
] };
const cellSchema = { type: 'object', additionalProperties: false, properties: {
  address: { type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$' }, value: cellValueSchema,
  numFmt: { type: 'string' }, bold: { type: 'boolean' },
}, required: ['address', 'value'] };
const text = { type: 'string' };
const pathSchema = { type: 'string', minLength: 1, description: 'Office 文件路径，后缀为 .docx、.xlsx 或 .pptx。' };

export function officeReadDeclaration(): ToolDeclaration {
  const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
  return {
    name: 'office_read',
    description: isZh
      ? '读取本地 Word (.docx)、Excel (.xlsx) 或 PowerPoint (.pptx) 的内容。Word 和 PPT 按段落返回 target，包含表格文字；Excel 返回工作表、单元格地址、值和公式。offset、limit 按段落或非空单元格计数；单次正文最多 16000 字符，长段落可用 textOffset 续读。保持筛选参数不变，用返回的 nextOffset 和 nextTextOffset 继续。修改时把 hash 交给 office_edit；公式结果来自文件中保存的缓存，不代表刚刚完成重算。'
      : 'Read local Word (.docx), Excel (.xlsx), or PowerPoint (.pptx) content. Word and PPT return paragraph targets, including table text; Excel returns sheets, cell addresses, values and formulas. offset and limit count paragraphs or nonempty cells. Each response has a 16000-character content budget; textOffset resumes a long paragraph. Continue with nextOffset and nextTextOffset, keeping filters unchanged. Pass hash to office_edit. Formula results are saved caches, not freshly calculated values.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      path: pathSchema, sheet: { ...text, description: '只读这个 Excel 工作表。' },
      part: { ...text, description: '只读这个 Word/PPT XML 部分，使用上次返回的 part。' },
      slide: { type: 'integer', minimum: 1, description: '只读第几张幻灯片，编号从 1 开始。' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
      textOffset: { type: 'integer', minimum: 0 },
    }, required: ['path'] },
  };
}

export function officeCreateDeclaration(): ToolDeclaration {
  const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
  return {
    name: 'office_create',
    description: isZh
      ? '创建新的 Office 文件，已有文件请用 office_edit。content 与后缀对应：docx 用 blocks（paragraph/heading 的 text，table 的 rows）；xlsx 用 sheets（name、rows、cells、columnWidths、merges），公式值写成 {formula:"SUM(A1:A3)"}；pptx 用 slides（title、text、notes，或 elements 中带坐标的文本框），幻灯片为 16:9，坐标单位为英寸。font 可指定字体。文件保存到工作区，通过文件树在外部 Office 应用打开；表格公式由外部应用打开时重算。'
      : 'Create a new Office file; use office_edit for existing files. content follows the suffix: docx uses blocks (paragraph/heading text or table rows); xlsx uses sheets (name, rows, cells, columnWidths, merges), with formulas as {formula:"SUM(A1:A3)"}; pptx uses slides (title, text, notes, or positioned text elements) on 16:9 slides with inch coordinates. font selects a font. Saved files can be opened from the file tree in an external Office app; spreadsheet formulas recalculate when opened there.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: pathSchema,
      content: { type: 'object', additionalProperties: false, properties: {
        title: text, font: text,
        blocks: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', additionalProperties: false, properties: {
          type: { type: 'string', enum: ['paragraph', 'heading', 'table'] }, text,
          level: { type: 'integer', minimum: 1, maximum: 6 },
          rows: { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, items: text } },
          bold: { type: 'boolean' }, italic: { type: 'boolean' }, fontSize: { type: 'number', exclusiveMinimum: 0 },
          alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        }, required: ['type'] } },
        sheets: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', minLength: 1, maxLength: 31 },
          rows: { type: 'array', maxItems: 10000, items: { type: 'array', maxItems: 1000, items: cellValueSchema } },
          cells: { type: 'array', maxItems: 10000, items: cellSchema },
          columnWidths: { type: 'array', maxItems: 1000, items: { type: 'number', exclusiveMinimum: 0 } },
          merges: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$' } },
        }, required: ['name'] } },
        slides: { type: 'array', minItems: 1, maxItems: 300, items: { type: 'object', additionalProperties: false, properties: {
          title: text, text, notes: text,
          elements: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
            text, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
            w: { type: 'number', exclusiveMinimum: 0 }, h: { type: 'number', exclusiveMinimum: 0 },
            fontSize: { type: 'number', exclusiveMinimum: 0 }, bold: { type: 'boolean' }, color: { type: 'string', pattern: '^[0-9A-Fa-f]{6}$' },
          }, required: ['text', 'x', 'y', 'w', 'h'] } },
        } } },
      } },
    }, required: ['path', 'content'] },
  };
}

export function officeEditDeclaration(): ToolDeclaration {
  const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
  return {
    name: 'office_edit',
    description: isZh
      ? '修改已有 Office 文件。先 office_read 获取 hash 和定位，expectedHash 必须与当前文件一致。Word/PPT 用 paragraphs 的 target、text 替换完整段落，沿用该段首个文字运行的字体格式，其他段落和资源保留；Word 还可用 appendParagraphs 追加段落。Excel 用 cells 的 sheet、address、value 修改单元格（null 清空，{formula:"A1+B1"} 写公式），保留已有样式与图表。现有 Excel 编辑只改值和公式；样式在创建时指定。表格改动使旧公式缓存失效，外部应用打开时重算。文件更新沿用工作区版本校验与恢复记录。'
      : 'Edit an existing Office file after office_read. expectedHash must match the current file. For Word/PPT, paragraphs target and text replace a complete paragraph using its first text run formatting, preserving other paragraphs and resources. Word can appendParagraphs. For Excel, cells use sheet, address and value (null clears a cell; {formula:"A1+B1"} sets a formula), preserving styles and charts. Existing spreadsheet edits change values/formulas only; set styles during creation. Changes invalidate formula caches for recalculation in an external app. Writes use workspace version checks and recovery records.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      path: pathSchema, expectedHash: { type: 'string', minLength: 1 },
      paragraphs: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', additionalProperties: false,
        properties: { target: { type: 'string', minLength: 1 }, text }, required: ['target', 'text'] } },
      appendParagraphs: { type: 'array', minItems: 1, maxItems: 2000, items: text },
      cells: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'object', additionalProperties: false,
        properties: { sheet: { type: 'string', minLength: 1 }, address: cellSchema.properties.address, value: cellValueSchema },
        required: ['sheet', 'address', 'value'] } },
    }, required: ['path', 'expectedHash'] },
  };
}
