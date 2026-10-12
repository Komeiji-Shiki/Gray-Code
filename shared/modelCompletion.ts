/** 只接受供应方明确的完成信号；未知原因不能让不完整总结替换原文。 */
export function getModelCompletionStatus(result: {
    completionStatus?: 'complete' | 'truncated' | 'incomplete';
    finishReason?: string;
}): 'complete' | 'truncated' | 'incomplete' {
    if (result.completionStatus) return result.completionStatus;
    switch (result.finishReason?.toLowerCase()) {
        case 'stop':
        case 'end_turn':
        case 'stop_sequence':
        case 'completed':
        case 'tool_calls':
        case 'tool_use':
        case 'function_call':
        case 'requires_action':
            return 'complete';
        case 'length':
        case 'max_tokens':
        case 'max_output_tokens':
        case 'max_completion_tokens':
        case 'model_context_window_exceeded':
            return 'truncated';
        default:
            return 'incomplete';
    }
}
