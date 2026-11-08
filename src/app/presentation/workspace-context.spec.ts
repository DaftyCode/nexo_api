import { TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { WorkspaceContext, environmentPreview } from './workspace-context';
import { WorkspaceState } from './workspace-state';

describe('Workspace context', () => {
  it('redacts sensitive values and excludes disabled variables from the preview', () => {
    const preview = environmentPreview({
      values: [
        { key: 'baseUrl', value: 'https://example.test' },
        { key: 'apiKey', value: 'private-api-key' },
        { key: 'custom', value: 'private-custom', type: 'secret' },
        { key: 'other', value: 'private-other', sensitive: true },
        { key: 'reference', value: '{{vault:private-reference}}' },
        { key: 'disabled', value: 'private-disabled', enabled: false },
      ],
    });
    expect(preview[0]).toEqual({ key: 'baseUrl', text: 'https://example.test', secret: false });
    expect(preview.slice(1)).toHaveLength(4);
    expect(preview.slice(1).every((row) => row.secret && row.text === '••••••••')).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('private-');
    expect(environmentPreview(undefined)).toEqual([]);
  });

  it('shares environment selection with the workspace in both directions', async () => {
    TestBed.configureTestingModule({ imports: [WorkspaceContext], providers: testProviders() });
    const state = TestBed.inject(WorkspaceState);
    state.documents.set(
      ['dev', 'prod'].map((id) => ({
        id,
        workspace_id: 'local',
        kind: 'environment',
        name: id,
        revision: 1,
        updated_at: 1,
        value: { values: [{ key: 'baseUrl', value: `https://${id}.example.test` }] },
      })),
    );
    const fixture = TestBed.createComponent(WorkspaceContext);
    await fixture.whenStable();
    const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>(
      'select',
    )!;
    select.value = 'dev';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(state.environmentId()).toBe('dev');
    expect(fixture.nativeElement.textContent).toContain('https://dev.example.test');
    state.environmentId.set('prod');
    await fixture.whenStable();
    expect(select.value).toBe('prod');
    expect(fixture.nativeElement.textContent).toContain('https://prod.example.test');
  });

  describe('recent requests and the current collection', () => {
    const history = (id: string, name: string, updated: number, value: unknown = undefined) => ({
      id,
      workspace_id: 'local',
      kind: 'history',
      name,
      revision: 1,
      updated_at: updated,
      value,
    });
    let state: WorkspaceState;
    beforeEach(() => {
      TestBed.configureTestingModule({ imports: [WorkspaceContext], providers: testProviders() });
      state = TestBed.inject(WorkspaceState);
      state.documents.set([
        history('h1', 'GET /users', 1),
        history('h2', 'POST /users', 3, {
          request: { method: 'POST' },
          response: { status: 201 },
        }),
        history('h3', 'DELETE /users/1', 2, {
          request: { method: 'DELETE' },
          response: { status: 404 },
        }),
        history('h4', '', 0),
        {
          id: 'shop',
          workspace_id: 'local',
          kind: 'collection',
          name: 'Shop',
          revision: 1,
          updated_at: 1,
          value: {
            info: { name: 'Shop' },
            item: [
              { name: 'List', request: { method: 'GET', url: 'x' } },
              { name: 'Orders', item: [{ name: 'Create', request: { method: 'POST' } }] },
            ],
          },
        },
      ]);
    });

    it('lists the latest history in the side panel and opens the collection tools', async () => {
      const fixture = TestBed.createComponent(WorkspaceContext);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const rows = [...root.querySelectorAll('.context-history-row')];
      expect(rows.map((row) => row.querySelector('.method-tag')?.textContent?.trim())).toEqual([
        'POST',
        'DELETE',
        'GET',
        'HTTP',
      ]);
      expect(root.querySelector('.context-status.danger')?.textContent).toBe('404');
      expect(root.textContent).toContain('Open a saved request to see its collection.');
      expect(root.textContent).toContain('Select an environment with variables.');

      state.newTab(undefined, 'shop', [0]);
      await fixture.whenStable();
      expect(root.querySelector('.context-collection-name')?.textContent).toBe('Shop');
      expect(root.textContent).toContain('2');
      root.querySelector<HTMLButtonElement>('[aria-label="Open runner"]')!.click();
      expect(state.section()).toBe('runner');
      root.querySelector<HTMLButtonElement>('[aria-label="Manage environments"]')!.click();
      expect(state.section()).toBe('environments');
      [...root.querySelectorAll<HTMLButtonElement>('.text-button')]
        .find((button) => button.textContent?.includes('View all'))!
        .click();
      expect(state.section()).toBe('history');
    });

    it('shows a strip of recent requests in the canvas layout', async () => {
      const fixture = TestBed.createComponent(WorkspaceContext);
      fixture.componentRef.setInput('layout', 'strip');
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelectorAll('.recent-strip button')).toHaveLength(5);
      root.querySelector<HTMLButtonElement>('.recent-view-all')!.click();
      expect(state.section()).toBe('history');
      state.documents.set([]);
      await fixture.whenStable();
      expect(root.textContent).toContain('Send a request to start your history.');
    });
  });
});
