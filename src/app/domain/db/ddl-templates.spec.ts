import { describe, expect, it } from 'vitest';
import { TEMPLATE_FOLDERS, newObjectScript } from './ddl-templates';

const postgres = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const tsql = { name: 'tsql', quoteOpen: '[', quoteClose: ']' };
const mysql = { name: 'mysql', quoteOpen: '`', quoteClose: '`' };
const sqlite = { name: 'sqlite', quoteOpen: '"', quoteClose: '"' };

describe('templates of new objects', () => {
  it('names the object in the schema of its folder', () => {
    expect(newObjectScript('views', postgres, 'shop')).toMatch(/^CREATE VIEW shop\.new_view AS/);
    expect(newObjectScript('functions', tsql, 'Sales')).toMatch(
      /^CREATE FUNCTION \[Sales\]\.new_function\(@value int\)/,
    );
  });

  it('uses dbo on SQL Server and no schema elsewhere when the folder has none', () => {
    expect(newObjectScript('procedures', tsql)).toMatch(/^CREATE PROCEDURE dbo\.new_procedure/);
    expect(newObjectScript('schemas', tsql)).toBe('CREATE SCHEMA new_schema');
    expect(newObjectScript('databases', mysql)).toBe('CREATE DATABASE new_database');
    expect(newObjectScript('triggers', sqlite)).toMatch(
      /^CREATE TRIGGER new_trigger\nAFTER UPDATE/,
    );
  });

  it('keeps a trigger of PostgreSQL unqualified, as the engine requires', () => {
    const script = newObjectScript('triggers', postgres, 'shop') ?? '';
    expect(script).toMatch(/^CREATE TRIGGER new_trigger\n/);
    expect(script).toContain('ON shop.table_name');
    expect(newObjectScript('views', postgres, 'Big Shop')).toContain('"Big Shop".new_view');
  });

  it('offers nothing for an object the engine does not have', () => {
    expect(newObjectScript('materialized-views', mysql)).toBeUndefined();
    expect(newObjectScript('sequences', sqlite)).toBeUndefined();
    expect(newObjectScript('tables', postgres)).toBeUndefined();
  });

  it('has a template for every folder it lists', () => {
    for (const folder of TEMPLATE_FOLDERS) expect(newObjectScript(folder, postgres)).toBeTruthy();
  });
});
