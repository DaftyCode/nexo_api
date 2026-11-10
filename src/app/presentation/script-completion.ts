import { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { membersAfter, pathBefore } from '../domain/script-api';

/** How far back a member path is read, for calls that span lines. */
const LOOKBEHIND = 2000;

/**
 * Suggests the members of the script API (`pm.` and `nx.`) where the cursor is, with how
 * they are called and what they do; nothing inside strings and comments.
 */
export function scriptCompletions(context: CompletionContext): CompletionResult | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/String|Comment|Template/.test(node.name)) return null;
  const before = context.state.sliceDoc(Math.max(0, context.pos - LOOKBEHIND), context.pos);
  const path = pathBefore(before);
  if (!path) return null;
  // Only `pm` and `nx` themselves at the start of a name: the language suggests the rest.
  if (!path.steps.length && !path.typed && !context.explicit) return null;
  const members = membersAfter(path.steps);
  if (!members?.length) return null;
  return {
    from: context.pos - path.typed.length,
    options: members.map((member) => ({
      label: member.name,
      type:
        member.kind === 'method' ? 'method' : member.kind === 'object' ? 'namespace' : 'property',
      detail: member.signature,
      info: member.doc,
    })),
    validFor: /^[\w$]*$/,
  };
}
