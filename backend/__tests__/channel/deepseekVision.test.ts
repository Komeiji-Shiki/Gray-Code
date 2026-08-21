import {
    calculateDeepSeekTileGrid,
    buildDeepSeekTileRegions,
    countHistoryImages,
    DEEPSEEK_VISION_MAX_IMAGES,
    DEEPSEEK_VISION_MAX_REQUEST_BYTES,
    DEEPSEEK_VISION_MAX_TILE_LONG_EDGE,
    DEEPSEEK_VISION_MAX_TILE_PIXELS,
    isDeepSeekVisionModel,
    prepareDeepSeekVisionHistory,
    validateDeepSeekVisionRequestBody
} from '../../modules/channel/deepseekVision';
import { getCanvas, getDependencyPath, getPdfjs, getSharp } from '../../modules/dependencies';

jest.mock('../../modules/dependencies', () => ({
    getCanvas: jest.fn(),
    getDependencyPath: jest.fn(),
    getPdfjs: jest.fn(),
    getSharp: jest.fn()
}));

const mockGetCanvas = getCanvas as jest.MockedFunction<typeof getCanvas>;
const mockGetDependencyPath = getDependencyPath as jest.MockedFunction<typeof getDependencyPath>;
const mockGetPdfjs = getPdfjs as jest.MockedFunction<typeof getPdfjs>;
const mockGetSharp = getSharp as jest.MockedFunction<typeof getSharp>;

function createSharpMock(
    width: number,
    height: number,
    output = Buffer.from('encoded-tile')
): jest.Mock {
    const factory = jest.fn(() => {
        const chain: any = {
            metadata: jest.fn().mockResolvedValue({ width, height }),
            rotate: jest.fn(() => chain),
            extract: jest.fn(() => chain),
            jpeg: jest.fn(() => chain),
            png: jest.fn(() => chain),
            webp: jest.fn(() => chain),
            toBuffer: jest.fn().mockResolvedValue(output)
        };
        return chain;
    });
    return factory;
}

function imagePart(width = 800, height = 800, data = Buffer.from('image').toString('base64')) {
    return {
        inlineData: {
            mimeType: 'image/png',
            data,
            name: 'diagram.png',
            id: 'attachment-1'
        },
        text: undefined
    };
}

describe('DeepSeek Vision preprocessing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetDependencyPath.mockReturnValue('/deps/pdfjs-dist');
    });

    test('only recognizes DeepSeek vision model identifiers', () => {
        expect(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp')).toBe(true);
        expect(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp:free')).toBe(true);
        expect(isDeepSeekVisionModel('deepseek-chat')).toBe(false);
        expect(isDeepSeekVisionModel('gpt-5-vision')).toBe(false);
    });

    test('calculates complete tiles under both pixel and long-edge limits', () => {
        const grid = calculateDeepSeekTileGrid(1_600, 1_600);
        const regions = buildDeepSeekTileRegions(1_600, 1_600, grid);

        expect(grid).toEqual({ columns: 2, rows: 2 });
        expect(regions).toHaveLength(4);
        expect(regions.reduce((sum, region) => sum + region.width * region.height, 0))
            .toBe(1_600 * 1_600);
        for (const region of regions) {
            expect(region.width * region.height).toBeLessThanOrEqual(DEEPSEEK_VISION_MAX_TILE_PIXELS);
            expect(Math.max(region.width, region.height)).toBeLessThanOrEqual(DEEPSEEK_VISION_MAX_TILE_LONG_EDGE);
        }
    });

    test('does not transform a supported image within the DeepSeek budget', async () => {
        mockGetSharp.mockResolvedValue(null);
        const originalPart = imagePart();
        const history = [{ role: 'user' as const, parts: [originalPart] }];

        const result = await prepareDeepSeekVisionHistory(
            history,
            'deepseek-v4-flash-vision-exp'
        );

        expect(result).not.toBe(history);
        expect(result[0].parts).toEqual([originalPart]);
        expect(result[0].parts[0]).toBe(originalPart);
    });

    test('splits an oversized image into ordered loss-preserving output parts', async () => {
        const sharp = createSharpMock(1_600, 1_600);
        mockGetSharp.mockResolvedValue(sharp);
        const history = [{ role: 'user' as const, parts: [imagePart(1_600, 1_600)] }];

        const result = await prepareDeepSeekVisionHistory(
            history,
            'deepseek-v4-flash-vision-exp'
        );

        expect(result[0].parts).toHaveLength(4);
        expect(result[0].parts.every(part => part.inlineData?.mimeType === 'image/png')).toBe(true);
        expect(result[0].parts.map(part => part.inlineData?.name)).toEqual([
            'diagram.png tile-1',
            'diagram.png tile-2',
            'diagram.png tile-3',
            'diagram.png tile-4'
        ]);
        expect(sharp).toHaveBeenCalled();
        expect(countHistoryImages(result)).toBe(4);
        // The input history is a request source and must not be rewritten in place.
        expect(history[0].parts).toHaveLength(1);
    });

    test('renders every PDF page as an image while preserving page order', async () => {
        const sharp = createSharpMock(800, 800);
        mockGetSharp.mockResolvedValue(sharp);

        const pages = [1, 2].map(pageNumber => ({
            getViewport: jest.fn(() => ({ width: 800, height: 800 })),
            render: jest.fn(() => ({ promise: Promise.resolve() })),
            cleanup: jest.fn(),
            pageNumber
        }));
        const document = {
            numPages: pages.length,
            getPage: jest.fn(async (pageNumber: number) => pages[pageNumber - 1]),
            cleanup: jest.fn(),
            destroy: jest.fn(async () => undefined)
        };
        const canvas = {
            getContext: jest.fn(() => ({})),
            toBuffer: jest.fn(() => Buffer.from('rendered-page'))
        };
        mockGetCanvas.mockResolvedValue({
            DOMMatrix: class DOMMatrix {},
            Path2D: class Path2D {},
            ImageData: class ImageData {},
            createCanvas: jest.fn(() => canvas)
        });
        mockGetPdfjs.mockResolvedValue({
            getDocument: jest.fn(() => ({ promise: Promise.resolve(document) }))
        });

        const history = [{
            role: 'user' as const,
            parts: [{
                inlineData: {
                    mimeType: 'application/pdf',
                    data: Buffer.from('%PDF-test').toString('base64'),
                    name: 'report.pdf',
                    id: 'pdf-1'
                }
            }]
        }];

        const result = await prepareDeepSeekVisionHistory(
            history,
            'deepseek-v4-flash-vision-exp'
        );

        expect(result[0].parts.map(part => part.text || part.inlineData?.name)).toEqual([
            '[PDF page 1/2: report.pdf]',
            'report.pdf page-1-tile-1',
            '[PDF page 2/2: report.pdf]',
            'report.pdf page-2-tile-1'
        ]);
        expect(result[0].parts.filter(part => part.inlineData)).toHaveLength(2);
        expect(document.getPage).toHaveBeenCalledWith(1);
        expect(document.getPage).toHaveBeenCalledWith(2);
        expect(document.destroy).toHaveBeenCalled();
    });

    test('rejects requests exceeding the DeepSeek image count', () => {
        const body = {
            input: Array.from({ length: DEEPSEEK_VISION_MAX_IMAGES + 1 }, () => ({
                type: 'input_image',
                image_url: 'https://example.test/image.png'
            }))
        };

        expect(() => validateDeepSeekVisionRequestBody(body)).toThrow(/600/);
    });

    test('rejects requests exceeding the DeepSeek request body limit', () => {
        const body = { prompt: 'x'.repeat(DEEPSEEK_VISION_MAX_REQUEST_BYTES + 1) };

        expect(() => validateDeepSeekVisionRequestBody(body)).toThrow(/48/);
    });
});
