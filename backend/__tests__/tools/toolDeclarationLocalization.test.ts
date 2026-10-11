import { resolveLocalizationLanguage } from '../../tools/localization/types';

describe('resolveLocalizationLanguage 语言归并', () => {
    test('zh-CN → zh-CN', () => {
        expect(resolveLocalizationLanguage('zh-CN')).toBe('zh-CN');
    });

    test('en → en', () => {
        expect(resolveLocalizationLanguage('en')).toBe('en');
    });

    test('ja → en（本阶段日文暂用英文模型说明）', () => {
        expect(resolveLocalizationLanguage('ja')).toBe('en');
    });

    test('未知语言 → en（兜底）', () => {
        expect(resolveLocalizationLanguage('fr')).toBe('en');
        expect(resolveLocalizationLanguage('')).toBe('en');
    });
});
