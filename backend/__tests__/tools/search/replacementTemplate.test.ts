import type { SearchFileHost } from '../../../tools/search/fileHost';
import { createReplacePass } from '../../../tools/search/replacePassRuntime';
import { DEFAULT_SEARCH_IN_FILES_CONFIG } from '../../../modules/settings/types';

const { expandReplacementTemplate } = createReplacePass({} as SearchFileHost);

test.each([
    ['首位为零的捕获组', /(X)/g, 'X', '$01'],
    ['首位为零的第九组', /()()()()()()()()(X)/g, 'X', '$09'],
    ['两位引用回退到已有的首位组', /()()()()()()()()(X)()()()9/g, 'X9', '$99'],
    ['不足十组时保留后缀数字', /(X)/g, 'X0', '$10'],
    ['组零仍为字面量', /(X)/g, 'X', '$00 $0'],
    ['已有命名组下缺失的名称替换为空', /(?<name>X)/g, 'X', '$<missing>'],
    ['空的命名引用与其他缺失名称一致', /(?<name>X)/g, 'X', '$<>'],
    ['没有命名组时保留模板文本', /(X)/g, 'X', '$<missing>'],
    ['可选捕获组未参与匹配', /(Y)?(?<name>X)/g, 'X', '$1$<name>'],
    ['前后文和美元符号', /(X)/g, 'beforeXafter', "$$-$&-$`-$'"],
] as const)('%s：计数用展开与实际原生替换一致', (_name, expression, text, replacement) => {
    const match = expression.exec(text)!;
    const expanded = expandReplacementTemplate(replacement, match[0], match.index, text, match.slice(1), match.groups);
    const actual = text.slice(0, match.index) + expanded + text.slice(match.index + match[0].length);
    expression.lastIndex = 0;
    expect(actual).toBe(text.replace(expression, replacement));
});

test('同一文件同时存在有变化和无变化的捕获组替换时，只统计实际变化项', async () => {
    const file = { fsPath: '/workspace/sample.txt', scheme: 'file' };
    const review = jest.fn(async () => ({ wasAccepted: true, wasInterrupted: false, pendingDiffId: 'fixture' }));
    const host = { findFiles: async () => [file], stat: async () => ({ size: 2, type: 1 }),
        readFile: async () => Buffer.from('XY'), toRelativePath: () => 'sample.txt', review } as unknown as SearchFileHost;
    const result = await createReplacePass(host).searchAndReplaceInDirectory(file, '*', /(X)|(Y)/g, '$01', 1, null, '',
        { ...DEFAULT_SEARCH_IN_FILES_CONFIG, enableHeaderTextCheck: false });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ originalContent: 'XY', newContent: 'X' }));
    expect(result).toMatchObject({ totalReplacements: 1, replacements: [{ replacements: 1, status: 'accepted' }] });
});
