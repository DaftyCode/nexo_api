/**
 * What the code editors need to know without loading CodeMirror: which language a text is
 * in. Kept apart so screens can choose a language and still load the editor deferred.
 */
/** The languages the code editors colour. */
export type CodeLanguage = 'json' | 'javascript' | 'yaml' | 'xml' | 'html' | 'graphql' | 'text';

/** A problem shown on a line, such as a finding of the API linter. */
export interface CodeMark {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** The language of a raw body, from what its type selector says. */
export function bodyLanguage(name: string | undefined): CodeLanguage {
  switch ((name ?? '').toLowerCase()) {
    case 'json':
      return 'json';
    case 'javascript':
      return 'javascript';
    case 'xml':
      return 'xml';
    case 'html':
      return 'html';
    case 'graphql':
      return 'graphql';
    default:
      return 'text';
  }
}
