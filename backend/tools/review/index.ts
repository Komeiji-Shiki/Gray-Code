/**
 * Review 工具模块
 */

import type { ToolRegistration } from '../types';

// 静态导入注册函数（与下方 re-export 共用同一模块实例，替代原函数内 require）
import { registerCreateReview } from './create_review';
import { registerRecordReviewMilestone } from './record_review_milestone';
import { registerFinalizeReview } from './finalize_review';
import { registerValidateReviewDocument } from './validate_review_document';
import { registerReopenReview } from './reopen_review';
import { registerCompareReviewDocuments } from './compare_review_documents';

export { registerCreateReview } from './create_review';
export { registerRecordReviewMilestone } from './record_review_milestone';
export { registerFinalizeReview } from './finalize_review';
export { registerValidateReviewDocument } from './validate_review_document';
export { registerReopenReview } from './reopen_review';
export { registerCompareReviewDocuments } from './compare_review_documents';

export function getReviewToolRegistrations(): ToolRegistration[] {
  return [registerCreateReview, registerRecordReviewMilestone, registerFinalizeReview, registerValidateReviewDocument, registerReopenReview, registerCompareReviewDocuments];
}
