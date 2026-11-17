import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { testProviders } from '../../testing/providers';
import { Chart } from './chart';

const series = [
  {
    name: 'active',
    points: [
      { at: new Date(2026, 0, 1, 10, 0, 0).getTime(), value: 2 },
      { at: new Date(2026, 0, 1, 10, 0, 5).getTime(), value: 6 },
    ],
  },
  { name: 'idle', points: [{ at: new Date(2026, 0, 1, 10, 0, 5).getTime(), value: 1 }] },
];

describe('Chart', () => {
  let fixture: ComponentFixture<Chart>;
  const root = () => fixture.nativeElement as HTMLElement;
  const set = async (inputs: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Chart],
    }).compileComponents();
    fixture = TestBed.createComponent(Chart);
    await set({ label: 'Sessions', unit: 'sessions' });
  });

  it('waits for a first reading, then draws lines with axes and a legend', async () => {
    expect(root().textContent).toContain('Waiting for the first reading…');
    await set({ series });
    const svg = root().querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Sessions. active: 6 sessions. idle: 1 sessions');
    expect(root().querySelectorAll('.chart-line')).toHaveLength(2);
    expect(root().querySelectorAll('.chart-area')).toHaveLength(0);
    expect(svg.textContent).toContain('10:00:05');
    expect(root().querySelector('.chart-legend')?.textContent).toContain('active');

    let width = 480;
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({ left: 0, width, top: 0, height: 180 }),
    });
    svg.dispatchEvent(new MouseEvent('pointermove', { clientX: 470 }));
    await fixture.whenStable();
    expect(root().querySelector('.chart-tip')?.textContent).toContain('active: 6 sessions');
    expect(root().querySelector('.chart-cursor')).not.toBeNull();
    svg.dispatchEvent(new MouseEvent('pointerleave'));
    await fixture.whenStable();
    expect(root().querySelector('.chart-tip')).toBeNull();
    width = 0;
    svg.dispatchEvent(new MouseEvent('pointermove', { clientX: 10 }));
  });

  it('draws areas, bars and a single value, per second when it is', async () => {
    await set({ series, kind: 'area' });
    expect(root().querySelectorAll('.chart-area')).toHaveLength(2);
    await set({ kind: 'bar' });
    expect(root().querySelectorAll('.chart-bar')).toHaveLength(2);
    expect(root().querySelector('.chart-bar title')?.textContent).toBe('active: 6 sessions');
    await set({ kind: 'value', unit: 'bytes', perSecond: true });
    expect(root().querySelector('.chart-value')?.textContent?.trim()).toBe('6 B/s');
  });

  it('shows the same numbers as a table, the latest first', async () => {
    await set({ series });
    root().querySelector<HTMLButtonElement>('.chart-foot button')!.click();
    await fixture.whenStable();
    const rows = [...root().querySelectorAll('tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent?.trim()),
    );
    expect(rows).toEqual([
      ['10:00:05', '6 sessions', '1 sessions'],
      ['10:00:00', '2 sessions', '—'],
    ]);
    await set({ kind: 'bar' });
    expect(root().querySelector('thead')?.textContent).toContain('Series');
    expect(root().querySelectorAll('tbody tr')).toHaveLength(2);
  });
});
