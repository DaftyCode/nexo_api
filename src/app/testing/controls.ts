import { ComponentFixture } from '@angular/core/testing';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
/** Makes every typed value different, also between calls. */
let typed = 0;

/** A readable name for a control in assertion messages. */
export function describeControl(control: Element): string {
  const label = control.closest('label')?.textContent?.trim().replace(/\s+/g, ' ');
  const name =
    control.getAttribute('aria-label') ?? control.getAttribute('placeholder') ?? label ?? '';
  return `${control.tagName.toLowerCase()}[${(control as Control).type ?? ''}] ${name}`.trim();
}

/** Changes a control as a user would: types, ticks or picks another option. */
export function change(control: Element, text = 'changed'): void {
  if (control instanceof HTMLSelectElement) {
    const other = [...control.options].find((option) => option.value !== control.value);
    if (other) control.value = other.value;
    control.dispatchEvent(new Event('change'));
    control.dispatchEvent(new Event('input'));
  } else if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    control.click();
  } else if (control instanceof HTMLInputElement && control.type === 'file') {
    control.dispatchEvent(new Event('change'));
  } else if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    control.value = control.type === 'number' ? '7' : text;
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
    control.dispatchEvent(new Event('blur'));
  }
}

/**
 * Changes, one at a time, every enabled control inside `root` and returns those whose change
 * did not reach `read()`. Controls removed by an earlier change are skipped.
 */
export async function exerciseControls(
  fixture: ComponentFixture<unknown>,
  read: () => unknown,
  options: { root?: Element; skip?: (control: Element) => boolean } = {},
): Promise<string[]> {
  const root = options.root ?? (fixture.nativeElement as HTMLElement);
  const controls = [...root.querySelectorAll('input, textarea, select')].filter(
    (control) => !(control as Control).disabled && !options.skip?.(control),
  );
  const unchanged: string[] = [];
  for (const control of controls) {
    if (!control.isConnected) continue;
    const before = JSON.stringify(read());
    change(control, `value-${++typed}`);
    await fixture.whenStable();
    if (JSON.stringify(read()) === before) unchanged.push(describeControl(control));
  }
  return unchanged;
}

/** The buttons inside `root` whose text matches. */
export function buttons(root: Element, text: string | RegExp): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter((button) => {
    const label = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`.trim();
    return typeof text === 'string' ? label.includes(text) : text.test(label);
  });
}

/** Clicks the first button whose text matches and waits for the view; fails when missing. */
export async function clickButton(
  fixture: ComponentFixture<unknown>,
  text: string | RegExp,
  root: Element = fixture.nativeElement as HTMLElement,
): Promise<void> {
  const [button] = buttons(root, text);
  if (!button) throw new Error(`No button ${String(text)}`);
  button.click();
  await fixture.whenStable();
}
