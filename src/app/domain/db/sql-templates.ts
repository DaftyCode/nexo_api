/**
 * Templates of the SQL editor, as DBeaver's: an abbreviation and Tab write a statement whose
 * `${table}`, `${column}`… are fields to fill (Tab goes to the next), and `${cursor}` is where
 * the cursor ends. The person's own are kept on this computer beside these.
 */
export interface SqlTemplate {
  name: string;
  description: string;
  text: string;
}

export const SQL_TEMPLATES: readonly SqlTemplate[] = [
  { name: 'sf', description: 'Select from', text: 'SELECT * FROM ${table}${cursor}' },
  { name: 'scount', description: 'Count the rows', text: 'SELECT COUNT(*) FROM ${table}${cursor}' },
  {
    name: 'sw',
    description: 'Select with a condition',
    text: 'SELECT * FROM ${table} WHERE ${column} = ${cursor}',
  },
  {
    name: 'sjoin',
    description: 'Select with a join',
    text: 'SELECT *\nFROM ${table} a\nJOIN ${other} b ON ${cursor}',
  },
  {
    name: 'sgroup',
    description: 'Count by a column',
    text: 'SELECT ${column}, COUNT(*)\nFROM ${table}\nGROUP BY ${column}\nORDER BY 2 DESC${cursor}',
  },
  {
    name: 'ins',
    description: 'Insert a row',
    text: 'INSERT INTO ${table} (${columns})\nVALUES (${cursor})',
  },
  {
    name: 'upd',
    description: 'Update rows',
    text: 'UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${cursor}',
  },
  { name: 'del', description: 'Delete rows', text: 'DELETE FROM ${table}\nWHERE ${cursor}' },
];

/** A template as CodeMirror's snippets write fields: `${cursor}` closes them. */
export function snippetText(template: SqlTemplate): string {
  return template.text.replaceAll('${cursor}', '${}');
}

/** The templates kept on this computer, read defensively. */
export function readTemplates(stored: string | undefined): SqlTemplate[] {
  try {
    const list: unknown = JSON.parse(stored ?? '[]');
    return (Array.isArray(list) ? list : []).flatMap((item) => {
      const template = (item ?? {}) as Partial<SqlTemplate>;
      return typeof template.name === 'string' &&
        /^\w+$/.test(template.name) &&
        typeof template.text === 'string' &&
        template.text.trim()
        ? [
            {
              name: template.name,
              description: String(template.description ?? ''),
              text: template.text,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}
