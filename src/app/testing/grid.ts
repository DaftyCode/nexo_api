import { ComponentFixture } from '@angular/core/testing';

/**
 * The data grid in a test, as a person uses it: a cell found by its text, chosen with a click
 * and opened with a double click, a row chosen by its number, and the column headers.
 */
async function settle(fixture: ComponentFixture<unknown>) {
  for (let i = 0; i < 4; i++) await fixture.whenStable();
}

/** The first cell drawn whose text is this one (or matches). */
export function gridCell(root: Element, text: string | RegExp): HTMLElement {
  const cells = [...root.querySelectorAll<HTMLElement>('[role="gridcell"][data-row]')];
  const found = cells.find((cell) => {
    const shown = cell.textContent?.trim() ?? '';
    return typeof text === 'string' ? shown === text : text.test(shown);
  });
  if (!found) throw new Error(`No cell ${String(text)}`);
  return found;
}

/** Chooses a cell, as a click on it does. */
export async function chooseCell(
  fixture: ComponentFixture<unknown>,
  text: string | RegExp,
  within: Element = fixture.nativeElement,
) {
  gridCell(within, text).click();
  await settle(fixture);
}

/** Opens a cell, as a double click on it does. */
export async function openCell(
  fixture: ComponentFixture<unknown>,
  text: string | RegExp,
  within: Element = fixture.nativeElement,
) {
  const cell = gridCell(within, text);
  cell.click();
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await settle(fixture);
}

/** Chooses a whole row by its number (from 1), as a click on it does. */
export async function chooseRow(
  fixture: ComponentFixture<unknown>,
  number: number,
  within: Element = fixture.nativeElement,
) {
  const header = within.querySelector<HTMLElement>(`[role="rowheader"][data-row="${number - 1}"]`);
  if (!header) throw new Error(`No row ${number}`);
  header.click();
  await settle(fixture);
}

/** The names of the columns shown. */
export function gridHeaders(root: Element): string[] {
  return [...root.querySelectorAll('[role="columnheader"] .grid-name')].map(
    (name) => name.textContent?.trim() ?? '',
  );
}

/**
 * Gives the grids of a test room on screen (jsdom measures every element as 0 pixels), so all
 * their columns and rows are drawn. Returns what puts the measures back.
 */
export function roomyGrids(width = 4000, height = 2000): () => void {
  const prototype = HTMLElement.prototype;
  const original = {
    width: Object.getOwnPropertyDescriptor(prototype, 'clientWidth'),
    height: Object.getOwnPropertyDescriptor(prototype, 'clientHeight'),
  };
  const sized = (size: number, fallback?: PropertyDescriptor) => ({
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList?.contains('grid-viewport')) return size;
      return fallback?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(prototype, 'clientWidth', sized(width, original.width));
  Object.defineProperty(prototype, 'clientHeight', sized(height, original.height));
  return () => {
    if (original.width) Object.defineProperty(prototype, 'clientWidth', original.width);
    if (original.height) Object.defineProperty(prototype, 'clientHeight', original.height);
  };
}
