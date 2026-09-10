import { randomUUID } from 'node:crypto';
import type { QuestionRequest, QuestionFeedback, UserQuestion } from '@graycode/contracts';
import type { RuntimeTool } from './tools';

interface Pending { request: QuestionRequest; timer: ReturnType<typeof setTimeout> }

/** Optional questions never grant permissions. Feedback is queued until tool calls are settled. */
export class QuestionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly feedback = new Map<string, QuestionFeedback[]>();
  private readonly waiters = new Map<string, () => void>();
  constructor(private readonly timeoutMs: number, private readonly resolved: (value: QuestionFeedback) => void) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Question timeout must be positive.');
  }
  ask(runId: string, actorId: string, questions: UserQuestion[]): QuestionRequest {
    if (this.list(runId).length >= 3) throw new Error('Three question requests are already pending.');
    const now = Date.now();
    const request: QuestionRequest = { id: randomUUID(), runId, actorId, questions: structuredClone(questions), createdAt: now, expiresAt: now + this.timeoutMs };
    const timer = setTimeout(() => this.finish(request.id), this.timeoutMs);
    this.pending.set(request.id, { request, timer });
    return request;
  }
  answer(id: string, answers: string[], answeredBy: string): QuestionFeedback {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('Question has expired or was already answered.');
    if (Date.now() >= pending.request.expiresAt) { this.finish(id); throw new Error('Question has expired.'); }
    if (!Array.isArray(answers) || answers.length !== pending.request.questions.length || answers.some(answer => typeof answer !== 'string' || answer.length > 16_000 || !answer.trim())) throw new Error('Provide one nonempty answer for each question.');
    return this.finish(id, answers, answeredBy)!;
  }
  private finish(id: string, answers?: string[], answeredBy?: string): QuestionFeedback | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer); this.pending.delete(id);
    const value = { request: pending.request, answers, answeredBy, timedOut: answers === undefined };
    const values = this.feedback.get(pending.request.runId) ?? [];
    values.push(value); this.feedback.set(pending.request.runId, values);
    this.resolved(value);
    this.waiters.get(pending.request.runId)?.();
    return value;
  }
  list(runId?: string): QuestionRequest[] { return [...this.pending.values()].filter(value => !runId || value.request.runId === runId).map(value => structuredClone(value.request)); }
  drain(runId: string): QuestionFeedback[] { const values = this.feedback.get(runId) ?? []; this.feedback.delete(runId); return values; }
  hasFeedback(runId: string): boolean { return (this.feedback.get(runId)?.length ?? 0) > 0; }
  async wait(runId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.hasFeedback(runId) || !this.list(runId).length) return;
    let wake!: () => void;
    const ready = new Promise<void>(resolve => { wake = resolve; });
    this.waiters.set(runId, wake); signal.addEventListener('abort', wake, { once: true });
    try { await ready; signal.throwIfAborted(); }
    finally { signal.removeEventListener('abort', wake); this.waiters.delete(runId); }
  }
  clear(runId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.runId === runId) { clearTimeout(pending.timer); this.pending.delete(id); }
    }
    this.feedback.delete(runId); this.waiters.get(runId)?.(); this.waiters.delete(runId);
  }
}

export function createAskUserTool(): RuntimeTool {
  return {
    declaration: { name: 'ask_user', description: 'Ask up to three optional questions while continuing independent work. Suggestions are optional; the user may type an answer. After a few minutes without an answer, decide within existing permissions. Never use for approvals, irreversible decisions, or required information.',
      parameters: { type: 'object', additionalProperties: false, required: ['questions'], properties: {
        questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['title'], properties: {
          title: { type: 'string', minLength: 1, maxLength: 2000 }, options: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 500 } },
        } } },
      } } },
    effects: () => ['public_read'],
    execute: async (args, context) => {
      const request = await context.askUser(args.questions as UserQuestion[]);
      return { success: true, data: { requestId: request.id, status: 'pending', expiresAt: request.expiresAt,
        instruction: 'Continue independent work. The answer or timeout notice will arrive after the current tool batch has settled.' } };
    },
  };
}
