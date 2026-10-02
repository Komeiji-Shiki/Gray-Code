import {
  applyDocumentTextPatch, composeDocumentChangeRegions, documentChangeRegion, documentTextPatch, trackDocumentChange,
  type DocumentChangeRegion, type DocumentContentChange, type TrackedDocumentChange,
} from '../../../shared/documentPatch';

// 按 Monaco 语义应用一次事件：changes 从文档末尾排到开头，偏移都基于事件前文本。
function applyEvent(text: string, changes: DocumentContentChange[]) {
  for (const change of changes) text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
  return text;
}
function random(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}
const alphabet = ['a', 'b', '\r\n', '\n', '中', '😺', ' '];
function randomEvent(next: () => number, text: string): DocumentContentChange[] {
  const count = 1 + Math.floor(next() * 3), changes: DocumentContentChange[] = [];
  let limit = text.length;
  for (let index = 0; index < count && limit >= 0; index++) {
    const rangeOffset = Math.floor(next() * (limit + 1)), rangeLength = Math.floor(next() * Math.min(4, limit - rangeOffset + 1));
    const insert = Array.from({ length: Math.floor(next() * 4) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    changes.push({ rangeOffset, rangeLength, text: insert });
    limit = rangeOffset - 1;
  }
  return changes;
}
const outsideEqual = (before: string, after: string, region: DocumentChangeRegion) =>
  before.slice(0, region.start) === after.slice(0, region.start)
  && before.slice(region.start + region.deleteCount) === after.slice(region.start + region.insertCount);

test('编辑器事件的多处变更合并为覆盖范围，范围外与原文一致，BOM 偏移得到补偿', () => {
  const before = '\uFEFFalpha\r\nbeta\r\ngamma';
  // 多光标：在 gamma 前和 alpha 后各输入一个字，Monaco 偏移不含 BOM。
  const changes = [{ rangeOffset: 13, rangeLength: 0, text: '😺' }, { rangeOffset: 5, rangeLength: 0, text: '中' }];
  const after = '\uFEFF' + applyEvent(before.slice(1), changes);
  const region = documentChangeRegion(changes, 1)!;
  expect(region).toEqual({ start: 6, deleteCount: 8, insertCount: 11 });
  expect(outsideEqual(before, after, region)).toBe(true);
  expect(applyDocumentTextPatch(before, documentTextPatch(before, after, region))).toBe(after);
  expect(documentChangeRegion([])).toBeUndefined();
  expect(documentChangeRegion([{ rangeOffset: 2, rangeLength: 3, text: '' }, { rangeOffset: 4, rangeLength: 1, text: 'x' }])).toBeUndefined();
  expect(documentChangeRegion([{ rangeOffset: -1, rangeLength: 0, text: '' }])).toBeUndefined();
});

test('范围提示只在范围内收缩前后缀；与文本长度不符时回退全文比较', () => {
  const before = 'x'.repeat(100_000) + 'old' + 'y'.repeat(100_000);
  const after = 'x'.repeat(100_000) + 'new' + 'y'.repeat(100_000);
  expect(documentTextPatch(before, after, { start: 99_990, deleteCount: 20, insertCount: 20 })).toEqual({ start: 100_000, deleteCount: 3, text: 'new' });
  // 范围与长度矛盾（例如基线已被外部替换）时不能信任，结果必须与不带提示一致。
  expect(documentTextPatch(before, after, { start: 0, deleteCount: 1, insertCount: 2 })).toEqual(documentTextPatch(before, after));
  expect(documentTextPatch(before, after, { start: 200_000, deleteCount: 10, insertCount: 10 })).toEqual(documentTextPatch(before, after));
});

test('输入法组合、代理对、撤销和随机多光标编辑累计后的补丁都能还原最新文本', () => {
  // 组合输入逐次替换未提交的拼音，最后提交表情（两个 UTF-16 单元）；随后撤销回原文。
  let tracked: TrackedDocumentChange | undefined, text = 'hello world';
  const base = text;
  for (const changes of [[{ rangeOffset: 5, rangeLength: 0, text: 'n' }], [{ rangeOffset: 5, rangeLength: 1, text: 'ni' }],
    [{ rangeOffset: 5, rangeLength: 2, text: '你😺' }]]) {
    const next = applyEvent(text, changes);
    tracked = trackDocumentChange(tracked, next, { previous: text, region: documentChangeRegion(changes)! }); text = next;
  }
  expect(text).toBe('hello你😺 world');
  expect(documentTextPatch(base, text, tracked!.region)).toEqual({ start: 5, deleteCount: 0, text: '你😺' });
  const undone = applyEvent(text, [{ rangeOffset: 5, rangeLength: 3, text: '' }]);
  tracked = trackDocumentChange(tracked, undone, { previous: text, region: documentChangeRegion([{ rangeOffset: 5, rangeLength: 3, text: '' }])! });
  expect(tracked!.base).toBe(base);
  expect(documentTextPatch(base, undone, tracked!.region)).toEqual({ start: 5, deleteCount: 0, text: '' });

  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    let current = Array.from({ length: Math.floor(next() * 40) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    const start = current;
    let composed: DocumentChangeRegion | undefined;
    for (let step = 0; step < 1 + Math.floor(next() * 6); step++) {
      const changes = randomEvent(next, current), after = applyEvent(current, changes);
      const region = documentChangeRegion(changes)!;
      expect(outsideEqual(current, after, region)).toBe(true);
      composed = composed ? composeDocumentChangeRegions(composed, region) : region;
      current = after;
    }
    expect(outsideEqual(start, current, composed!)).toBe(true);
    const patch = documentTextPatch(start, current, composed);
    expect(applyDocumentTextPatch(start, patch)).toBe(current);
    expect(patch.start).toBeGreaterThanOrEqual(composed!.start);
    expect(patch.start + patch.deleteCount).toBeLessThanOrEqual(composed!.start + composed!.deleteCount);
  }
});

test('没有可靠范围的编辑或中间缺失的变化会重新起算，不沿用旧基线', () => {
  const first = trackDocumentChange(undefined, 'ab', { previous: 'a', region: { start: 1, deleteCount: 0, insertCount: 1 } })!;
  expect(first).toEqual({ base: 'a', text: 'ab', region: { start: 1, deleteCount: 0, insertCount: 1 } });
  // 外部重置或移动端全文输入没有范围。
  expect(trackDocumentChange(first, 'xyz')).toBeUndefined();
  // 编辑前文本与记录不符（中间有未报告的替换），只能从这次编辑前的文本起算。
  expect(trackDocumentChange(first, 'zzq', { previous: 'zz', region: { start: 2, deleteCount: 0, insertCount: 1 } }))
    .toEqual({ base: 'zz', text: 'zzq', region: { start: 2, deleteCount: 0, insertCount: 1 } });
  // 发送后以已发文本为基线（无范围），接着的编辑直接作为相对新基线的范围。
  expect(trackDocumentChange({ base: 'ab', text: 'ab' }, 'abc', { previous: 'ab', region: { start: 2, deleteCount: 0, insertCount: 1 } }))
    .toEqual({ base: 'ab', text: 'abc', region: { start: 2, deleteCount: 0, insertCount: 1 } });
});
