import {
  CompletionContext,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** Colours of the app's dark code editors. */
export const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#ff7b72' },
  { tag: [tags.propertyName, tags.attributeName], color: '#c6d5cc' },
  { tag: [tags.variableName, tags.special(tags.variableName)], color: '#79c0ff' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: '#d2a8ff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a5d6ff' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#79c0ff' },
  { tag: tags.comment, color: '#8b949e', fontStyle: 'italic' },
  { tag: tags.punctuation, color: '#8b949e' },
]);

/** The look of the code editors, as the `.code-editor` text areas had. */
export const theme = EditorView.theme(
  {
    '&': {
      background: '#14171b',
      color: '#c6d5cc',
      border: '1px solid var(--border)',
      borderRadius: '5px',
      fontSize: '11px',
      height: '100%',
    },
    '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.8', overflow: 'auto' },
    '.cm-content': { caretColor: '#c6d5cc', padding: '10px 0' },
    '.cm-gutters': { background: '#14171b', color: '#8b949e', border: 'none' },
    '.cm-activeLine, .cm-activeLineGutter': { background: '#ffffff08' },
    '.cm-placeholder': { color: '#8b949e' },
    '.cm-selectionMatch': { background: '#ffffff14' },
    '.cm-searchMatch': { background: '#d2992240', outline: '1px solid #d2992280' },
    '.cm-panels': { background: 'var(--panel)', color: 'var(--text)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '11px' },
    '.cm-tooltip': {
      background: 'var(--panel)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'color-mix(in srgb, var(--accent) 35%, transparent)',
      color: 'var(--text)',
    },
    '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '1em' },
    '.cm-completionInfo': { maxWidth: '320px', padding: '6px 8px' },
  },
  { dark: true },
);

/**
 * What every code editor has: line numbers, undo, search (Ctrl+F), brackets, colours, a name
 * for screen readers, and the text sent back on each change. Tab is not taken: it still
 * moves the focus out of the editor.
 */
export function baseExtensions(options: {
  label: string;
  placeholder: string;
  changed: (text: string) => void;
}): Extension[] {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    autocompletion({ activateOnTyping: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    syntaxHighlighting(highlight),
    placeholder(options.placeholder),
    // Focusable by name for assistive technology, which then may scroll it with the keyboard;
    // the editing area already was a tab stop, so this adds none.
    EditorView.contentAttributes.of({
      'aria-label': options.label,
      spellcheck: 'false',
      tabindex: '0',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.changed(update.state.doc.toString());
    }),
    theme,
  ];
}

/** A read-only editor still selects and copies, but takes no typing. */
export function readOnly(value: boolean): Extension {
  return [EditorState.readOnly.of(value), EditorView.editable.of(!value)];
}

/** The start and end of a line (from 1), clamped to the document. */
export function lineSpan(view: EditorView, line: number) {
  const number = Math.min(Math.max(line, 1), view.state.doc.lines);
  const found = view.state.doc.line(number);
  return { from: found.from, to: found.to };
}

/**
 * Suggests `words` (field names, with their dots) while one is typed, besides what the
 * language suggests.
 */
export function wordCompletions(words: readonly string[]): Extension {
  if (!words.length) return [];
  const options = words.map((label) => ({ label, type: 'property' }));
  // One source per list: CodeMirror tells sources apart by identity, and a new one each time
  // it asks would keep the completion pending.
  const source = (context: CompletionContext) => {
    const word = context.matchBefore(/[\w$.]+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options, validFor: /^[\w$.]*$/ };
  };
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}
