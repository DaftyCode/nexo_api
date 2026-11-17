import { describe, expect, it } from 'vitest';
import { erdModel, tableFromModel } from './erd';
import { erdLayout } from './erd-layout';
import { erdScene, noteBox } from './erd-scene';
import { erdPalette, erdSvg } from './erd-svg';
import { readTable } from './structure';

const customers = tableFromModel(
  readTable({
    name: 'customers & co',
    columns: [
      { name: 'id', typeName: 'int', nullable: false },
      { name: 'name', typeName: 'text', nullable: true },
    ],
    primaryKey: { columns: ['id'] },
  }),
  ['tables', 'customers & co'],
);
const invoices = tableFromModel(
  readTable({
    name: 'invoices',
    columns: [
      { name: 'id', typeName: 'int', nullable: false },
      { name: 'customer', typeName: 'int', nullable: true },
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [
      { columns: ['customer'], referencedTable: 'customers & co', referencedColumns: ['id'] },
    ],
  }),
  ['tables', 'invoices'],
);
const model = erdModel([customers, invoices]);
const view = { detail: 'all' as const, types: false };

describe('the scene of a diagram', () => {
  it('places each entity, with its rows, its color and the lines and notes around it', () => {
    const scene = erdScene({
      model,
      view,
      notation: 'crowsfoot',
      auto: erdLayout(model, view),
      positions: { invoices: { x: 600, y: 300 } },
      colors: { invoices: 'success' },
      notes: [{ id: 'n1', text: 'one\ntwo', x: 900, y: 700 }],
    });
    const invoice = scene.entities.find((entity) => entity.key === 'invoices')!;
    expect(invoice).toMatchObject({ box: { x: 600, y: 300 }, color: 'success' });
    expect(invoice.rows.map((row) => [row.text, row.primary, row.foreign])).toEqual([
      ['id', true, false],
      ['customer', false, true],
    ]);
    expect(invoice.rows[1].y - invoice.rows[0].y).toBe(18);
    expect(scene.lines[0]).toMatchObject({ from: 'invoices', to: 'customers & co' });
    expect(scene.notes[0].box).toEqual(noteBox(scene.notes[0]));
    expect(scene.notes[0].box.height).toBe(48);
    expect(scene.bounds.x + scene.bounds.width).toBeGreaterThan(900 + 200);
    const nowhere = erdScene({ model, view, notation: 'uml', auto: {}, positions: {} });
    expect(nowhere.entities.map((entity) => entity.box.x)).toEqual([0, 0]);
    expect(nowhere.notes).toEqual([]);
  });
});

describe('a diagram as an SVG file', () => {
  const tokens: Record<string, string> = {
    '--nexo-color-bg': ' #101010',
    '--nexo-color-surface': '#202020',
    '--nexo-color-success': '#00aa00',
    '--nexo-font-sans': 'Inter, "Segoe UI"',
  };
  const palette = erdPalette((name) => tokens[name] ?? 'gray');

  it('reads its palette from the tokens of the theme in use', () => {
    expect(palette).toMatchObject({ background: '#101010', surface: '#202020', text: 'gray' });
    expect(palette.colors.success).toBe('#00aa00');
  });

  it('draws the scene with those colors, escaping names and notes', () => {
    const scene = erdScene({
      model,
      view: { detail: 'all', types: true },
      notation: 'idef1x',
      auto: erdLayout(model, view),
      positions: {},
      colors: { invoices: 'success' },
      notes: [{ id: 'n1', text: 'a < b\nsecond', x: 0, y: 400 }],
    });
    const svg = erdSvg(scene, palette);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('font-family="Inter, &quot;Segoe UI&quot;"');
    expect(svg).toContain('fill="#101010"');
    expect(svg).toContain('stroke="#00aa00"');
    expect(svg).toContain('customers &amp; co');
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('>PK</text>');
    expect(svg).toContain('>FK</text>');
    expect(svg).toContain('a &lt; b');
    expect(svg).toContain('>second</text>');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    const uml = erdSvg(
      erdScene({ model, view, notation: 'uml', auto: erdLayout(model, view), positions: {} }),
      palette,
    );
    expect(uml).toContain('>*</text>');
  });
});
