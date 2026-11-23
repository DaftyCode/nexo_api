import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AiUse } from '../domain/ai';
import { buttons, clickButton } from '../testing/controls';
import { testProviders } from '../testing/providers';
import { AiAnswer } from './ai-answer';
import { WorkspaceState } from './workspace-state';

describe('AiAnswer', () => {
  let fixture: ComponentFixture<AiAnswer>;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const create = async (inputs: Record<string, unknown>) => {
    fixture = TestBed.createComponent(AiAnswer);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [AiAnswer],
    }).compileComponents();
  });

  it('shows the tools it read with, its prose and its code with the buttons of the place', async () => {
    await create({
      text: 'Run this:\n```sql\nSELECT 1\n```\nIt counts.',
      steps: [
        { tool: 'sql_describe_table', detail: 'public.orders' },
        { tool: 'sql_query', detail: 'Prod', failed: true },
        { tool: 'weird_tool' },
      ],
      place: 'sql',
    });
    expect(text()).toContain('Read the table public.orders');
    expect(text()).toContain('Ran a query that reads on Prod');
    expect(text()).toContain('Used weird_tool');
    expect(root().querySelectorAll('li.failed')).toHaveLength(1);
    expect(text()).toContain('Run this:');
    expect(text()).toContain('It counts.');
    expect(root().querySelector('pre')?.textContent).toBe('SELECT 1');
    const used: AiUse[] = [];
    fixture.componentInstance.use.subscribe((use) => used.push(use));
    await clickButton(fixture, 'Open in a new tab');
    await clickButton(fixture, /^Run$/);
    expect(used).toEqual([
      { action: 'open', code: 'SELECT 1', language: 'sql' },
      { action: 'run', code: 'SELECT 1', language: 'sql' },
    ]);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    await clickButton(fixture, /^Copy$/);
    expect(TestBed.inject(WorkspaceState).toast()).toMatchObject({
      title: 'Copied to the clipboard',
    });
  });

  it('offers nothing to use while it is written, nor what the place cannot take', async () => {
    await create({ text: '```sql\nSELECT 1\n```', place: 'sql', actionable: false });
    expect(buttons(root(), /^Run$/)).toHaveLength(0);
    expect(buttons(root(), /^Copy$/)).toHaveLength(1);
    fixture.componentRef.setInput('place', 'request');
    fixture.componentRef.setInput('actionable', true);
    await fixture.whenStable();
    expect(buttons(root(), 'Add to the tests')).toHaveLength(0);
    fixture.componentRef.setInput('text', '```js\npm.test("ok", () => {});\n```\n```\nplain\n```');
    await fixture.whenStable();
    expect(buttons(root(), 'Add to the tests')).toHaveLength(1);
    expect(text()).toContain('Code');
  });
});
