import {
  defaultVisualTemplate,
  resolveVisualTemplate,
  templateArrangements,
  visualTemplate,
  visualTemplates,
} from './appearance';

describe('Visual templates', () => {
  it('offers the light Aurora first, as the default, and the dark one as Aurora full color', () => {
    expect(visualTemplates.map(({ id, name }) => [id, name])).toEqual([
      ['aurora', 'Aurora'],
      ['aurora-color', 'Aurora full color'],
      ['studio', 'Studio'],
      ['canvas', 'Canvas'],
    ]);
    expect(defaultVisualTemplate).toBe('aurora');
  });

  it('lays out both Aurora templates the same way and only the light one has light code', () => {
    expect(
      visualTemplates.map(({ id, arrangement, darkCode }) => [id, arrangement, darkCode]),
    ).toEqual([
      ['aurora', 'aurora', false],
      ['aurora-color', 'aurora', true],
      ['studio', 'studio', true],
      ['canvas', 'canvas', true],
    ]);
    for (const { arrangement } of visualTemplates)
      expect(templateArrangements).toContain(arrangement);
  });

  it('falls back to the default template for anything unknown', () => {
    expect(resolveVisualTemplate('aurora-color')).toBe('aurora-color');
    expect(visualTemplate('canvas').arrangement).toBe('canvas');
    for (const value of [undefined, null, 'classic', 'AURORA', { id: 'studio' }]) {
      expect(resolveVisualTemplate(value)).toBe('aurora');
      expect(visualTemplate(value).darkCode).toBe(false);
    }
  });
});
