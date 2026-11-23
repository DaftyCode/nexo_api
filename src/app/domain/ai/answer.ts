import type { AiPlace } from '../ai';

/** A piece of an answer: prose, or a fenced block of code with its language. */
export type AnswerPart =
  { kind: 'text'; text: string } | { kind: 'code'; language: string; code: string };

/** What a block of code can become: the request's tests, a SQL tab, the MongoDB query. */
export type AiCodeAction = 'tests' | 'open' | 'run' | 'use';

/** An action on a block of code, for the place the chat is in to do. */
export interface AiUse {
  action: AiCodeAction;
  code: string;
  language: string;
}

const OPENING = /^\s*```\s*([\w+#.-]*)/;
const CLOSING = /^\s*```\s*$/;

/** The answer cut at its fenced blocks; a block still being written counts as code. */
export function answerParts(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let prose: string[] = [];
  let code: string[] | undefined;
  let language = '';
  const flush = () => {
    const joined = prose.join('\n').trim();
    if (joined) parts.push({ kind: 'text', text: joined });
    prose = [];
  };
  for (const line of text.split('\n')) {
    const opening = code === undefined ? OPENING.exec(line) : null;
    if (opening) {
      flush();
      code = [];
      language = (opening[1] ?? '').toLowerCase();
    } else if (code !== undefined && CLOSING.test(line)) {
      parts.push({ kind: 'code', language, code: code.join('\n') });
      code = undefined;
    } else {
      (code ?? prose).push(line);
    }
  }
  if (code !== undefined) parts.push({ kind: 'code', language, code: code.join('\n') });
  flush();
  return parts;
}

const SCRIPTS = ['javascript', 'js'];
const SQL = ['', 'sql', 'mysql', 'postgresql', 'postgres', 'pgsql', 'plsql', 'tsql', 'sqlite'];
const DOCUMENTS = ['', 'json', 'json5', 'javascript', 'js'];

/** What a block of `language` can become in a place. */
export function codeActions(place: AiPlace, language: string): AiCodeAction[] {
  if (place === 'request') return SCRIPTS.includes(language) ? ['tests'] : [];
  if (place === 'sql') return SQL.includes(language) ? ['open', 'run'] : [];
  return DOCUMENTS.includes(language) ? ['use', 'run'] : [];
}

const SHELL_CALL = /^db\.[\w$.-]+\.(?:find|aggregate)\(([\s\S]*)\)$/;

/**
 * A MongoDB filter or pipeline from a block of code: an array is a pipeline, anything else a
 * filter; `db.orders.find(…)` and `db.orders.aggregate(…)` are unwrapped.
 */
export function mongoQueryOf(code: string): { kind: 'filter' | 'pipeline'; text: string } {
  let text = code.trim().replace(/;$/, '').trim();
  const call = SHELL_CALL.exec(text);
  if (call) text = (call[1] ?? '').trim();
  return { kind: text.startsWith('[') ? 'pipeline' : 'filter', text };
}
