import { ComponentFixture, TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { RequestTabbar } from './request-tabbar';
import { WorkspaceState } from './workspace-state';

describe('RequestTabbar', () => {
  let fixture: ComponentFixture<RequestTabbar>;
  let state: WorkspaceState;
  const bar = () =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.request-tabbar')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [RequestTabbar],
    }).compileComponents();
    state = TestBed.inject(WorkspaceState);
    fixture = TestBed.createComponent(RequestTabbar);
    await fixture.whenStable();
  });

  it('takes the colour of the active environment', async () => {
    expect(bar().classList).not.toContain('environment-marked');
    state.documents.set([
      {
        id: 'prod',
        workspace_id: 'local',
        kind: 'environment',
        name: 'Production',
        revision: 1,
        updated_at: 1,
        value: { values: [], color: '#57ab5a' },
      },
    ]);
    state.selectEnvironment('prod');
    await fixture.whenStable();
    expect(bar().classList).toContain('environment-marked');
    expect(bar().style.getPropertyValue('--nexo-environment-mark')).toBe('#57ab5a');
  });
});
