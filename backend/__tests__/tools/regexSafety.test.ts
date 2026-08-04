import { isRegexPotentiallyCatastrophic } from '../../tools/utils';

describe('isRegexPotentiallyCatastrophic', () => {
    it('flags overlapping alternation branches followed by a quantifier', () => {
        expect(isRegexPotentiallyCatastrophic('(a|aa)+$')).toBe(true);
        expect(isRegexPotentiallyCatastrophic('(ab|a)+')).toBe(true);
        expect(isRegexPotentiallyCatastrophic('(a|ab)*')).toBe(true);
    });

    it('flags nested quantifier groups', () => {
        expect(isRegexPotentiallyCatastrophic('(a+)+')).toBe(true);
        expect(isRegexPotentiallyCatastrophic('(a*)*')).toBe(true);
        expect(isRegexPotentiallyCatastrophic('(a+){2,}')).toBe(true);
    });

    it('flags extremely large repeat counts', () => {
        expect(isRegexPotentiallyCatastrophic('a{1,100000}')).toBe(true);
        expect(isRegexPotentiallyCatastrophic('a{0,1000000}')).toBe(true);
    });

    it('flags unanchored greedy prefixes', () => {
        expect(isRegexPotentiallyCatastrophic('.*foo')).toBe(true);
        expect(isRegexPotentiallyCatastrophic('(?:.|\\n)*foo')).toBe(true);
    });

    it('treats anchored greedy prefixes as safe', () => {
        expect(isRegexPotentiallyCatastrophic('^.*foo')).toBe(false);
        expect(isRegexPotentiallyCatastrophic('.*foo$')).toBe(false);
    });

    it('flags patterns longer than 200 characters', () => {
        expect(isRegexPotentiallyCatastrophic('a'.repeat(201))).toBe(true);
    });

    it('treats simple quantifiers as safe', () => {
        expect(isRegexPotentiallyCatastrophic('a+')).toBe(false);
        expect(isRegexPotentiallyCatastrophic('ab+')).toBe(false);
        expect(isRegexPotentiallyCatastrophic('[a-z]+')).toBe(false);
        expect(isRegexPotentiallyCatastrophic('^[a-z]+$')).toBe(false);
    });

    it('treats empty and non-string inputs as safe', () => {
        expect(isRegexPotentiallyCatastrophic('')).toBe(false);
        expect(isRegexPotentiallyCatastrophic(undefined as unknown as string)).toBe(false);
    });
});
