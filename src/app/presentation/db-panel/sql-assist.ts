import {
  Completion,
  CompletionContext as EditorCompletion,
  acceptCompletion,
  completionStatus,
  snippet,
  snippetCompletion,
} from '@codemirror/autocomplete';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap } from '@codemirror/view';
import { Suggestion } from '../../domain/db/completion-options';
import { SqlTemplate, snippetText } from '../../domain/db/sql-templates';

/** What the editor asks of the schema and the person's templates. */
export interface SqlAssistSource {
  /** What to offer in a statement with the cursor at `cursor` of it. */
  complete(statement: string, cursor: number): Promise<Suggestion[]>;
  /** The columns of a table, to show over its name; undefined for any other word. */
  describe(word: string): Promise<string | undefined>;
  /** Opens the object a name is (F4 or Ctrl+click). */
  open(word: string): void;
  templates(): readonly SqlTemplate[];
}

/** The statement around `at`: from the `;` before it to the one after it. */
function statementAround(doc: string, at: number): { text: string; start: number } {
  const start = doc.lastIndexOf(';', at - 1) + 1;
  const next = doc.indexOf(';', at);
  return { text: doc.slice(start, next < 0 ? doc.length : next), start };
}

/** The word (a name, maybe quoted) at a position of the text. */
function wordAt(state: EditorState, at: number): string | undefined {
  const line = state.doc.lineAt(at);
  const offset = at - line.from;
  const pattern = /"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line.text)))
    if (match.index <= offset && offset <= match.index + match[0].length)
      return /^["`[]/.test(match[0]) ? match[0].slice(1, -1) : match[0];
  return undefined;
}

const KINDS: Record<Suggestion['type'], string> = {
  table: 'class',
  view: 'class',
  column: 'property',
  join: 'text',
  columns: 'text',
  keyword: 'keyword',
  function: 'function',
};

/**
 * The SQL assistance of the editor, as DBeaver's: completion with the schema and the
 * templates (Tab fills their fields), the columns of a table over its name, and F4 or
 * Ctrl+click to open it.
 */
export function sqlAssist(source: SqlAssistSource): Extension {
  const complete = async (context: EditorCompletion) => {
    const doc = context.state.doc.toString();
    const { text, start } = statementAround(doc, context.pos);
    const word = context.matchBefore(/[\w$]*/);
    const suggestions = await source.complete(text, context.pos - start);
    if (!suggestions.length && !context.explicit && !word?.text) return null;
    const options: Completion[] = suggestions.map((suggestion, rank) => ({
      label: suggestion.label,
      apply: suggestion.apply,
      type: KINDS[suggestion.type],
      ...(suggestion.detail ? { detail: suggestion.detail } : {}),
      boost: suggestion.type === 'join' || suggestion.type === 'columns' ? 99 : -rank / 1000,
    }));
    const typed = word?.text ?? '';
    const templates = source
      .templates()
      .filter((template) => typed && template.name.startsWith(typed.toLowerCase()))
      .map((template) =>
        snippetCompletion(snippetText(template), {
          label: template.name,
          detail: template.description,
          type: 'snippet',
          boost: 50,
        }),
      );
    const star = suggestions.find((suggestion) => suggestion.type === 'columns');
    const from =
      star && doc[context.pos - 1] === '*' ? context.pos - 1 : (word?.from ?? context.pos);
    return { from, options: [...templates, ...options], validFor: /^[\w$]*$/ };
  };
  // Tab takes a suggestion, or writes the template whose abbreviation is before the cursor
  // (DBeaver's); with neither, it still moves the focus out of the editor. A list that has
  // just changed takes no key yet (CodeMirror's `interactionDelay`), so the template is tried.
  const tab = (view: EditorView) => {
    if (completionStatus(view.state) === 'active' && acceptCompletion(view)) return true;
    const { head, empty } = view.state.selection.main;
    const typed = view.state.sliceDoc(Math.max(0, head - 40), head).match(/[\w$]+$/)?.[0];
    const template =
      empty && typed
        ? source.templates().find((each) => each.name === typed.toLowerCase())
        : undefined;
    if (!template || !typed) return false;
    snippet(snippetText(template))(view, null, head - typed.length, head);
    return true;
  };
  const openAt = (view: EditorView, at: number) => {
    const word = wordAt(view.state, at);
    if (word) source.open(word);
    return !!word;
  };
  return [
    EditorState.languageData.of(() => [{ autocomplete: complete }]),
    hoverTooltip(async (view, at) => {
      const word = wordAt(view.state, at);
      const text = word ? await source.describe(word) : undefined;
      if (!text) return null;
      return {
        pos: at,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'cm-sql-info';
          dom.textContent = text;
          return { dom };
        },
      };
    }),
    keymap.of([
      { key: 'F4', run: (view) => openAt(view, view.state.selection.main.head) },
      { key: 'Tab', run: tab },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
        return at !== null && openAt(view, at);
      },
    }),
    EditorView.theme({
      '.cm-sql-info': {
        padding: 'var(--nexo-space-3) var(--nexo-space-4)',
        whiteSpace: 'pre',
        fontFamily: 'var(--nexo-font-mono)',
        fontSize: 'var(--nexo-font-size-sm)',
      },
    }),
  ];
}
