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
});
