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

/** Colours of the code editors, from the theme's syntax tokens. */
export const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--nexo-color-syntax-keyword)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--nexo-color-code-text)' },
  {
    tag: [tags.variableName, tags.special(tags.variableName)],
    color: 'var(--nexo-color-syntax-variable)',
  },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--nexo-color-syntax-type)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--nexo-color-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--nexo-color-syntax-number)' },
  { tag: tags.comment, color: 'var(--nexo-color-syntax-comment)', fontStyle: 'italic' },
  { tag: tags.punctuation, color: 'var(--nexo-color-syntax-comment)' },
]);

/** The look of the code editors, as the `.code-editor` text areas had. */
export const theme = EditorView.theme(
  {
    '&': {
      background: 'var(--nexo-color-code-bg)',
      color: 'var(--nexo-color-code-text)',
      border: 'var(--nexo-border-width) solid var(--nexo-color-border)',
      borderRadius: 'var(--nexo-radius-md)',
      fontSize: 'var(--nexo-font-size-xs)',
      height: '100%',
    },
    '&.cm-focused': {
      outline: 'var(--nexo-focus-ring-width) solid var(--nexo-color-focus-ring)',
      outlineOffset: 'calc(-1 * var(--nexo-border-width))',
    },
    '.cm-scroller': {
      fontFamily: 'var(--nexo-font-mono)',
      lineHeight: 'var(--nexo-line-height-loose)',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: 'var(--nexo-color-code-text)', padding: 'var(--nexo-space-5) 0' },
    '.cm-gutters': {
      background: 'var(--nexo-color-code-bg)',
      color: 'var(--nexo-color-syntax-comment)',
      border: 'none',
    },
    '.cm-activeLine, .cm-activeLineGutter': { background: 'var(--nexo-color-hover)' },
    '.cm-placeholder': { color: 'var(--nexo-color-syntax-comment)' },
    '.cm-selectionMatch': {
      background: 'color-mix(in srgb, var(--nexo-color-highlight) 8%, transparent)',
    },
    '.cm-searchMatch': {
      background: 'color-mix(in srgb, var(--nexo-color-warning) 25%, transparent)',
      outline:
        'var(--nexo-border-width) solid color-mix(in srgb, var(--nexo-color-warning) 50%, transparent)',
    },
    '.cm-panels': { background: 'var(--nexo-color-surface)', color: 'var(--nexo-color-text)' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      fontSize: 'var(--nexo-font-size-xs)',
    },
    '.cm-tooltip': {
      background: 'var(--nexo-color-surface)',
      color: 'var(--nexo-color-text)',
      border: 'var(--nexo-border-width) solid var(--nexo-color-border)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'color-mix(in srgb, var(--nexo-color-accent) 35%, transparent)',
      color: 'var(--nexo-color-text)',
    },
    '.cm-completionDetail': {
      color: 'var(--nexo-color-text-muted)',
      fontStyle: 'normal',
      marginLeft: '1em',
    },
    '.cm-completionInfo': { maxWidth: '320px', padding: 'var(--nexo-space-3) var(--nexo-space-4)' },
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
