/**
 * Minimal Jev client for the hook: the same evaluateWithJev contract as
 * classify-with-jev.ts, without the AI SDK and zod dependencies, so the
 * bundled hook stays small.
 */
import { TypeSafeClient, type EntryType, type Question as TypeSafeQuestion } from '@typesafe-ai/sdk';

const MODEL = process.env.JEV_MODEL ?? 'jev-latest';
let client: TypeSafeClient | undefined;

type BooleanQuestion = { type: 'boolean'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
type ChoiceQuestion = { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> };
type ScoreQuestion = { type: 'score'; instructions: unknown; criteria: unknown[] };
export type HookQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

function toTypeSafe(q: HookQuestion): TypeSafeQuestion {
  switch (q.type) {
    case 'boolean':
      return { type: 'noul', instructions: q.instructions, criteria: q.criteria } as unknown as TypeSafeQuestion;
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: q.criteria } as unknown as TypeSafeQuestion;
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.criteria } as unknown as TypeSafeQuestion;
  }
}

export async function evaluateWithJev({ state, questions }: { state: unknown; questions: Record<string, HookQuestion> }) {
  client ??= new TypeSafeClient();
  const result = await client.systemOne({
    model: MODEL,
    state: state as EntryType,
    questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toTypeSafe(q)])),
  });
  return {
    model: result.model,
    answers: result.answers as Record<string, unknown>,
    usage: {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      totalTokens: result.usage.input_tokens + result.usage.output_tokens,
    },
  };
}
