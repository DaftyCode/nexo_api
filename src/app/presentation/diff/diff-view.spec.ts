import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EditorView } from '@codemirror/view';
import { buttons, clickButton } from '../../testing/controls';
import { testProviders } from '../../testing/providers';
import { DiffView } from './diff-view';

describe('DiffView', () => {
  let fixture: ComponentFixture<DiffView>;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent?.replace(/\s+/g, ' ') ?? '';
  /** Waits for the merge view, which loads apart. */
  const built = async () => {
    for (let i = 0; i < 20 && !root().querySelector('.cm-mergeView'); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await fixture.whenStable();
  };
  const editor = (label: string) =>
    EditorView.findFromDOM(
      root().querySelector<HTMLElement>(`.cm-content[aria-label="${label}"]`)!,
    )!;

  async function show(source: string, target: string, language = 'text') {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DiffView],
    }).compileComponents();
    fixture = TestBed.createComponent(DiffView);
    fixture.componentRef.setInput('source', source);
    fixture.componentRef.setInput('target', target);
    fixture.componentRef.setInput('language', language);
    fixture.componentRef.setInput('sourceLabel', 'Staging');
    fixture.componentRef.setInput('targetLabel', 'Production');
    await fixture.whenStable();
    await built();
  }

  it('shows both texts side by side and goes from one difference to the next', async () => {
    const lines = Array.from({ length: 40 }, (_, n) => `line ${n}`);
    const changed = [...lines];
    changed[2] = 'line two';
    changed[30] = 'line thirty';
    await show(lines.join('\n'), changed.join('\n'));
    expect(text()).toContain('Staging');
    expect(text()).toContain('Production');
    expect(editor('Staging').state.doc.line(3).text).toBe('line 2');
    expect(editor('Production').state.doc.line(3).text).toBe('line two');
    // Read only: the texts are not edited.
    expect(editor('Staging').state.readOnly).toBe(true);
    expect(text()).toContain('Differences: 2');
    const [previous] = buttons(root(), 'Previous difference');
    const [next] = buttons(root(), 'Next difference');
    expect(previous.disabled).toBe(true);
    await clickButton(fixture, 'Next difference');
    expect(text()).toContain('Difference 1 of 2');
    expect(editor('Production').state.selection.main.head).toBe(
      editor('Production').state.doc.line(3).from,
    );
    await clickButton(fixture, 'Next difference');
    expect(text()).toContain('Difference 2 of 2');
    expect(next.disabled).toBe(true);
    expect(editor('Staging').state.selection.main.head).toBe(
      editor('Staging').state.doc.line(31).from,
    );
    await clickButton(fixture, 'Previous difference');
    expect(text()).toContain('Difference 1 of 2');
  });

  it('says equal texts are equal, and shows new texts when they change', async () => {
    await show('{"a": 1}', '{"a": 1}', 'json');
    expect(text()).toContain('The texts are equal');
    expect(buttons(root(), 'Next difference')[0].disabled).toBe(true);
    fixture.componentRef.setInput('target', '{"a": 2}');
    await fixture.whenStable();
    for (let i = 0; i < 20 && editor('Production').state.doc.toString() !== '{"a": 2}'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await fixture.whenStable();
    expect(editor('Production').state.doc.toString()).toBe('{"a": 2}');
    expect(root().querySelectorAll('.cm-mergeView')).toHaveLength(1);
    expect(text()).toContain('Differences: 1');
    fixture.destroy();
  });
});
