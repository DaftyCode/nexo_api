// The history in the sidebar: comparing its last two responses.
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import { buttons, renderDeferred } from '../testing/controls';
import { testProviders } from '../testing/providers';
import { CompareStore } from './compare/compare-store';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';

const entry = (id: string, at: number): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind: 'history',
  name: `GET https://api.test/${id}`,
  revision: 1,
  updated_at: at,
  value: null,
});

describe('Workspace history', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<Workspace>;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Workspace],
    }).compileComponents();
    fixture = TestBed.createComponent(Workspace);
    state = TestBed.inject(WorkspaceState);
    await state.initialize();
    await settle();
  }, 20_000);

  it('compares its last two responses, the older one first', async () => {
    state.section.set('history');
    state.documents.set([entry('one', 1)]);
    await settle();
    const [compare] = buttons(root(), 'Compare responses');
    expect(compare.disabled).toBe(true);
    state.documents.set([entry('one', 1), entry('two', 3), entry('three', 2)]);
    await settle();
    compare.click();
    await settle();
    await renderDeferred(fixture);
    const store = TestBed.inject(CompareStore);
    expect(state.section()).toBe('compare');
    expect(store.model().source).toMatchObject({ kind: 'history', history: 'three' });
    expect(store.model().target).toMatchObject({ kind: 'history', history: 'two' });
    expect(root().textContent).toContain('Back to History');
    expect(root().querySelector('app-response-compare h1')?.textContent).toContain(
      'Compare responses',
    );
  });
});
