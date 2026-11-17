/**
 * Objects that are code more than columns (views, routines, sequences, triggers, schemas, databases):
 * DBeaver opens a text editor with a template for them, and so does Nexo, a script with the
 * template of the engine to complete and run.
 */

import type { SqlStyle } from './grid/copy';
import { quoteName } from './tree';

/** The folders of the tree whose objects start from a template. */
export const TEMPLATE_FOLDERS = [
  'views',
  'materialized-views',
  'functions',
  'procedures',
  'sequences',
  'triggers',
  'schemas',
  'databases',
] as const;

const TEMPLATES: Record<string, Record<string, string>> = {
  views: {
    default: 'CREATE VIEW {s}new_view AS\nSELECT *\nFROM table_name\nWHERE condition',
  },
  'materialized-views': {
    postgresql: 'CREATE MATERIALIZED VIEW {s}new_view AS\nSELECT *\nFROM table_name\nWITH DATA',
  },
  functions: {
    postgresql:
      'CREATE FUNCTION {s}new_function(value integer)\nRETURNS integer\nLANGUAGE sql\nAS $$\n  SELECT value + 1\n$$',
    mysql:
      'CREATE FUNCTION {s}new_function(value int)\nRETURNS int DETERMINISTIC\nRETURN value + 1',
    tsql: 'CREATE FUNCTION {s}new_function(@value int)\nRETURNS int\nAS\nBEGIN\n  RETURN @value + 1\nEND',
  },
  procedures: {
    postgresql:
      'CREATE PROCEDURE {s}new_procedure(value integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- statements\nEND\n$$',
    mysql: 'CREATE PROCEDURE {s}new_procedure(IN value int)\nBEGIN\n  SELECT value;\nEND',
    tsql: 'CREATE PROCEDURE {s}new_procedure @value int\nAS\nBEGIN\n  SELECT @value\nEND',
  },
  sequences: {
    postgresql: 'CREATE SEQUENCE {s}new_sequence\n  START WITH 1\n  INCREMENT BY 1\n  MINVALUE 1',
    mysql: 'CREATE SEQUENCE {s}new_sequence\n  START WITH 1\n  INCREMENT BY 1',
    tsql: 'CREATE SEQUENCE {s}new_sequence\n  START WITH 1\n  INCREMENT BY 1\n  MINVALUE 1',
  },
  triggers: {
    postgresql:
      'CREATE TRIGGER new_trigger\nBEFORE UPDATE ON {s}table_name\nFOR EACH ROW\nEXECUTE FUNCTION {s}trigger_function()',
    mysql:
      'CREATE TRIGGER {s}new_trigger\nBEFORE UPDATE ON table_name\nFOR EACH ROW\nSET NEW.updated = NOW()',
    tsql: 'CREATE TRIGGER {s}new_trigger\nON {s}table_name\nAFTER UPDATE\nAS\nBEGIN\n  SET NOCOUNT ON\nEND',
    sqlite:
      'CREATE TRIGGER {s}new_trigger\nAFTER UPDATE ON table_name\nBEGIN\n  UPDATE table_name SET updated = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;\nEND',
  },
  schemas: {
    default: 'CREATE SCHEMA new_schema',
  },
  databases: {
    default: 'CREATE DATABASE new_database',
  },
};

/**
 * The template of a new object of a folder, for an engine (its SQL style's name), its names
 * in the schema of the folder when there is one; none when the engine has no such object.
 */
export function newObjectScript(
  folder: string,
  style: SqlStyle,
  schema?: string,
): string | undefined {
  const templates = TEMPLATES[folder];
  const template = templates?.[style.name] ?? templates?.['default'];
  const named = schema ?? (style.name === 'tsql' && folder !== 'schemas' ? 'dbo' : undefined);
  const prefix = named ? `${quoteName(named, style)}.` : '';
  return template?.replaceAll('{s}', prefix);
}
