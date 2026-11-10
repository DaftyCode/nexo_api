import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, fill } from '../testing/controls';
import { asCollection } from '../domain/models';
import { CollectionSettingsPanel } from './collection-settings-panel';
import { WorkspaceState } from './workspace-state';

describe('CollectionSettingsPanel', () => {
  let fixture: ComponentFixture<CollectionSettingsPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  const collection = () => asCollection(state.collections()[0].value);
  const tab = async (name: string) => {
    buttons(root().querySelector('.editor-tabs')!, name)[0].click();
    await fixture.whenStable();
  };
  const authType = async (type: string) => {
    const select = [...root().querySelectorAll('select')].find((element) =>
      [...element.options].some((option) => option.value === 'hawk'),
    )!;
    select.value = type;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [CollectionSettingsPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    await state.initialize();
    fixture = TestBed.createComponent(CollectionSettingsPanel);
    await fixture.whenStable();
  });

  it('asks for a collection first', async () => {
    expect(root().textContent).toContain('Choose a collection to edit its settings.');
    await state.createCollection('Shop');
    await fixture.whenStable();
    const select = root().querySelector<HTMLSelectElement>('select[aria-label="Collection"]')!;
    select.value = state.collections()[0].id;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(root().textContent).toContain('Collection settings');
  });

  it('exports the documentation of the collection', async () => {
    await state.createCollection('Shop');
    state.openCollectionSettings(state.collections()[0].id);
    await settle();
    await clickButton(fixture, 'Export documentation (PDF)');
    expect(state.report()).toMatchObject({ kind: 'collection', title: 'Shop' });
    state.closeReport();
    expect(api.released).toBe(1);

    // A collection that cannot be read says so instead.
    state.documents.update((documents) =>
      documents.map((d) => (d.kind === 'collection' ? { ...d, value: 'broken' } : d)),
    );
    state.reportCollection(state.collections()[0].id);
    expect(state.report()).toBeUndefined();
    expect(state.error()).not.toBe('');
    state.reportCollection('missing');
    expect(state.report()).toBeUndefined();
  });

  it('saves the variables, authorization and scripts of a collection', async () => {
    await state.createCollection('Shop');
    state.openCollectionSettings(state.collections()[0].id);
    await settle();
    await clickButton(fixture, 'Add variable');
    const keys = root().querySelectorAll<HTMLInputElement>('[aria-label="Variable name"]');
    keys[0].value = 'base';
    keys[0].dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(root().textContent).toContain('Unsaved changes');

    await tab('Authorization');
    await authType('bearer');
    await tab('Scripts');
    await fill(fixture, 'Pre-request script', 'console.log(1)');
    await fill(fixture, 'Tests', 'pm.test("ok", () => {})');
    await clickButton(fixture, 'Save collection');
    await settle();
    expect(root().textContent).not.toContain('Unsaved changes');
    const saved = collection();
    expect(saved['variable']).toEqual([expect.objectContaining({ key: 'base' })]);
    expect(saved['auth']).toMatchObject({ type: 'bearer' });
    expect(JSON.stringify(saved['event'])).toContain('console.log(1)');
  });

  it('edits a folder that inherits its authorization and gets OAuth 2.0 tokens', async () => {
    await state.createCollection('Shop');
    const [shop] = state.collections();
    await state.addFolder(shop, 'Orders');
    state.openCollectionSettings(shop.id, [0], 'authorization');
    await settle();
    expect(root().textContent).toContain('Folder settings');
    expect(root().textContent).toContain('No folder or collection above');
    await clickButton(fixture, 'Set an authorization for the collection');
    expect(state.settingsPath()).toEqual([]);
    state.openCollectionSettings(shop.id, [0], 'authorization');
    await settle();
    await clickButton(fixture, 'Shop');
    expect(state.settingsPath()).toEqual([]);

    state.openCollectionSettings(shop.id, [0], 'authorization');
    await settle();
    api.responses['oauth2.token'] = {
      id: 'tok',
      name: 'Token',
      hasRefreshToken: false,
      hasIdToken: false,
      reference: 'oauth2:tok',
      idReference: 'oauth2:tok:id',
    };
    await authType('oauth2');
    const grant = [...root().querySelectorAll('select')].find((element) =>
      [...element.options].some((option) => option.value === 'client_credentials'),
    )!;
    grant.value = 'client_credentials';
    grant.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    await clickButton(fixture, 'Get new access token');
    await settle();
    // Saved in the folder at once, and said in a toast.
    const stored = collection().item[0]['auth'] as {
      type: string;
      oauth2: { key: string; value: unknown }[];
    };
    expect(stored.type).toBe('oauth2');
    expect(stored.oauth2).toEqual(
      expect.arrayContaining([{ key: 'oauth2TokenId', value: 'tok', type: 'string' }]),
    );
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Access token obtained',
      message: 'oauth2.keptSaved',
    });
    await clickButton(fixture, 'Save folder');
    await settle();
    expect(collection().item[0]['auth']).toMatchObject({ type: 'oauth2' });
  });
});
