import { ComponentFixture, DeferBlockState } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';

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

/** The CodeMirror view of a code editor's editing area. */
export function codeView(content: Element): EditorView {
  const view = EditorView.findFromDOM(content as HTMLElement);
  if (!view) throw new Error('Not a code editor');
  return view;
}
/** Replaces the text of a code editor, as typing it would. */
export function typeCode(content: Element, text: string) {
  const view = codeView(content);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
/** The code editor whose accessible name is `label`. */
export function codeEditor(root: Element, label: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`);
  if (!found) throw new Error(`No code editor ${label}`);
  return found;
}
/** The text of a code editor. */
export function codeText(root: Element, label: string) {
  return codeView(codeEditor(root, label)).state.doc.toString();
}
/** Renders every @defer block now (code editors load deferred), nested ones included. */
export async function renderDeferred(fixture: ComponentFixture<unknown>) {
  for (let round = 0; round < 3; round++) {
    const blocks = await fixture.getDeferBlocks();
    if (!blocks.length) break;
    for (const block of blocks) await block.render(DeferBlockState.Complete);
    await fixture.whenStable();
  }
}

/** Changes a control as a user would: types, ticks or picks another option. */
export function change(control: Element, text = 'changed'): void {
  if (control.classList.contains('cm-content')) {
    typeCode(control, text);
    return;
  }
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
  await renderDeferred(fixture);
  const controls = [...root.querySelectorAll('input, textarea, select, .cm-content')].filter(
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

/**
 * The control a label names: inside the label or field whose text starts with it, else the
 * element with that accessible name. Code editors count as controls.
 */
export function control(root: Element, label: string): Element {
  const holder = [...root.querySelectorAll('label, .field')].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  const found =
    holder?.querySelector('input, select, textarea, .cm-content') ??
    root.querySelector(`[aria-label="${label}"]`);
  if (!found) throw new Error(`No control ${label}`);
  return found;
}
/** Types a value into the control a label names, code editors included. */
export async function fill(
  fixture: ComponentFixture<unknown>,
  label: string,
  value: string,
  root: Element = fixture.nativeElement as HTMLElement,
) {
  await renderDeferred(fixture);
  const target = control(root, label);
  if (target.classList.contains('cm-content')) typeCode(target, value);
  else {
    (target as HTMLInputElement).value = value;
    target.dispatchEvent(new Event('input'));
    target.dispatchEvent(new Event('change'));
  }
  await fixture.whenStable();
}
/** The value of the control a label names. */
export function valueOf(root: Element, label: string): string {
  const target = control(root, label);
  return target.classList.contains('cm-content')
    ? codeView(target).state.doc.toString()
    : (target as HTMLInputElement).value;
}
