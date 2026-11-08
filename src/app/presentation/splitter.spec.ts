import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Splitter } from './splitter';

@Component({
  imports: [Splitter],
  template: `
    <div class="studio">
      <div class="panel"></div>
      <app-splitter
        [axis]="axis()"
        target=".panel"
        [neighbor]="neighbor()"
        [neighborMin]="100"
        [invert]="invert()"
        label="Resize the panel"
        (resized)="sizes.push($event)"
        (settled)="settled = settled + 1"
        (restore)="restored = restored + 1"
      />
      <div class="neighbor"></div>
    </div>
  `,
})
class Host {
  readonly axis = signal<'x' | 'y'>('x');
  readonly neighbor = signal('.neighbor');
  readonly invert = signal(false);
  sizes: number[] = [];
  settled = 0;
  restored = 0;
}

describe('Splitter', () => {
  const pointer = (type: string, init: MouseEventInit) =>
    Object.assign(new MouseEvent(type, { bubbles: true, ...init }), { pointerId: 1 });

  async function setup() {
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    const size = (selector: string, width: number, height: number) =>
      (root.querySelector(selector)!.getBoundingClientRect = () => ({ width, height }) as DOMRect);
    await fixture.whenStable();
    size('.panel', 300, 200);
    size('.neighbor', 400, 150);
    const splitter = root.querySelector<HTMLElement>('app-splitter')!;
    return { fixture, host: fixture.componentInstance, splitter };
  }

  it('resizes its panel by dragging, without squeezing the neighbor', async () => {
    const { fixture, host, splitter } = await setup();
    expect(splitter.getAttribute('role')).toBe('separator');
    expect(splitter.getAttribute('aria-orientation')).toBe('vertical');
    splitter.dispatchEvent(pointer('pointermove', { clientX: 50 }));
    splitter.dispatchEvent(pointer('pointerdown', { button: 2, clientX: 0 }));
    splitter.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 100 }));
    await fixture.whenStable();
    expect(splitter.classList.contains('dragging')).toBe(true);
    splitter.dispatchEvent(pointer('pointermove', { clientX: 150 }));
    splitter.dispatchEvent(pointer('pointermove', { clientX: 1000 }));
    splitter.dispatchEvent(pointer('pointerup', {}));
    splitter.dispatchEvent(pointer('pointerup', {}));
    expect(host.sizes).toEqual([350, 600]);
    expect(host.settled).toBe(1);
    expect(splitter.getAttribute('title')).toBe('Resize the panel');
  });

  it('moves with the arrow keys and restores on double click', async () => {
    const { fixture, host, splitter } = await setup();
    const press = (key: string, shiftKey = false) =>
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    press('ArrowRight');
    press('ArrowLeft', true);
    press('ArrowUp');
    host.axis.set('y');
    host.invert.set(true);
    host.neighbor.set('');
    await fixture.whenStable();
    expect(splitter.getAttribute('aria-orientation')).toBe('horizontal');
    press('ArrowDown');
    expect(host.sizes).toEqual([316, 236, 184]);
    expect(host.settled).toBe(3);
    splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(host.restored).toBe(1);
  });

  it('does nothing without its panel', async () => {
    const { fixture, host, splitter } = await setup();
    fixture.nativeElement.querySelector('.panel').remove();
    splitter.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 100 }));
    splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(host.sizes).toEqual([]);
  });
});
