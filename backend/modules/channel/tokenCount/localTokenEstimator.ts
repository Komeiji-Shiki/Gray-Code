import type { Content } from '../../conversation/types';
import { MessageTokenEstimator } from '../../api/chat/services/MessageTokenEstimator';
import { describeTextTokenizer, type TokenizerOptions } from '../../../../packages/core/src/tokenizer';
import type { TokenCountResult } from './types';

/** 显式本地计数入口与上下文预算共用 tokenizer，返回词表来源而非供应方精确计数。 */
export function estimateLocalTokens(contents: Content[], options: TokenizerOptions = {}): TokenCountResult {
    const estimator = new MessageTokenEstimator(options);
    const basis = describeTextTokenizer(options);
    return {
        success: true,
        totalTokens: contents.reduce((total, content) => total + estimator.estimateMessageTokens(content), 0),
        source: basis.source,
        encoding: basis.encoding
    };
}
