import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { testProviders } from '../../testing/providers';
import { DbTypePicker } from './type-picker';

const types = ['bigint', 'boolean', 'character varying', 'date', 'integer', 'numeric', 'text'];

describe('DbTypePicker', () => {
  let fixture: ComponentFixture<DbTypePicker>;
  let chosen: string[];
  const root = () => fixture.nativeElement as HTMLElement;
  const field = () => root().querySelector<HTMLInputElement>('input')!;
  const options = () =>
    [...root().querySelectorAll('[role="option"]')].map((option) =>
      option.textContent?.replace('✓', '').trim(),
    );
  const key = async (name: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    field().dispatchEvent(event);
    await fixture.whenStable();
    return event;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DbTypePicker],
    }).compileComponents();
    fixture = TestBed.createComponent(DbTypePicker);
    fixture.componentRef.setInput('value', 'character varying(255)');
    fixture.componentRef.setInput('types', types);
    fixture.componentRef.setInput('label', 'Type of name');
    chosen = [];
    fixture.componentInstance.changed.subscribe((type) => chosen.push(type));
    await fixture.whenStable();
  });

  it('opens the whole list with its button, the current type marked', async () => {
    expect(field().getAttribute('role')).toBe('combobox');
    expect(field().getAttribute('aria-expanded')).toBe('false');
    root().querySelector<HTMLButtonElement>('button')!.click();
    await fixture.whenStable();
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(options()).toEqual(types);
    const current = root().querySelector('.db-type-current');
    expect(current?.textContent?.trim()).toBe('character varying ✓');
    expect(current?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(field().getAttribute('aria-activedescendant')).toBe(current?.id);
    root()
      .querySelectorAll<HTMLElement>('[role="option"]')[5]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(chosen).toEqual(['numeric']);
    expect(root().querySelector('[role="listbox"]')).toBeNull();
    root().querySelector<HTMLButtonElement>('button')!.click();
    await fixture.whenStable();
    root().querySelector<HTMLButtonElement>('button')!.click();
    await fixture.whenStable();
    expect(root().querySelector('[role="listbox"]')).toBeNull();
  });

  it('moves through the list with the keyboard and takes a type with Enter', async () => {
    await key('ArrowUp');
    expect(root().querySelector('[role="listbox"]')).toBeNull();
    expect((await key('ArrowDown')).defaultPrevented).toBe(true);
    expect(options()).toHaveLength(types.length);
    await key('ArrowDown');
    expect(root().querySelector('.db-type-active')?.textContent?.trim()).toBe('date');
    await key('ArrowUp');
    await key('Home');
    expect(root().querySelector('.db-type-active')?.textContent?.trim()).toBe('bigint');
    await key('End');
    await key('Enter');
    expect(chosen).toEqual(['text']);
    const escape = await key('Escape');
    expect(escape.defaultPrevented).toBe(false);
  });

  it('narrows the list only by what is typed, and keeps a type written by hand', async () => {
    field().value = 'int';
    field().dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(options()).toEqual(['bigint', 'integer']);
    field().value = 'varchar(100)';
    field().dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(options()).toEqual(['No type matches']);
    const escape = await key('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(root().querySelector('[role="listbox"]')).toBeNull();
    await key('Enter');
    expect(chosen).toEqual(['varchar(100)']);
    field().dispatchEvent(new Event('blur'));
    expect(chosen).toHaveLength(1);
    fixture.componentRef.setInput('value', 'varchar(100)');
    await fixture.whenStable();
    field().dispatchEvent(new Event('change'));
    expect(chosen).toHaveLength(1);
  });

  it('closes when the window scrolls or changes size', async () => {
    await key('ArrowDown');
    document.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    expect(root().querySelector('[role="listbox"]')).toBeNull();
    await key('ArrowDown');
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    expect(root().querySelector('[role="listbox"]')).toBeNull();
  });
});
