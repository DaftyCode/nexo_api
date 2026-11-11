import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ApiFailure } from '../application/ports';
import { WorkspaceDocument, newRequest } from '../domain/models';
import { emptyVariable } from '../domain/variables';
import { ToastMessage } from './toast-message';
import { WorkspaceState } from './workspace-state';

describe('Saving says in a toast what was saved, what was not and why', () => {
  let fixture: ComponentFixture<ToastMessage>;
  let api: TestApi;
  let state: WorkspaceState;
  const toast = () => (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.toast');
  /** The toast as the person reads it: its title, message and detail. */
  const shown = async () => {
    await fixture.whenStable();
    return [...(toast()?.querySelectorAll('strong, p') ?? [])]
      .map((line) => line.textContent?.trim())
      .join(' ');
  };
  /** Errors the next saves fail with, one each; then they save again. */
  let failures: unknown[] = [];
  const save = {
    failWith(...errors: unknown[]) {
      failures = errors;
    },
    wrap(target: TestApi) {
      const original = target.save.bind(target);
      target.save = async (document: WorkspaceDocument) => {
        const error = failures.shift();
        if (error) throw error;
        return original(document);
      };
    },
  };
  const shop = () => state.collections().find((d) => d.name === 'Shop')!;

  beforeEach(async () => {
    failures = [];
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ToastMessage],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    save.wrap(api);
    state = TestBed.inject(WorkspaceState);
    state.confirm = () => true;
    await state.initialize();
    fixture = TestBed.createComponent(ToastMessage);
    await state.createCollection('Shop');
  });

  it('names the request saved and its collection', async () => {
    expect(await shown()).toContain('Collection created "Shop"');
    state.newTab({ ...newRequest('r1'), name: 'List orders' });
    expect(await state.saveActive(shop().id)).toBe(true);
    expect(await shown()).toContain('Request saved "List orders" saved in the collection "Shop".');
    expect(toast()?.getAttribute('role')).toBe('status');
    expect(state.notice()).toBe('Request saved');
    expect(state.active()?.dirty).toBe(false);
  });

  it('says once why a request could not be saved, and keeps its changes in the tab', async () => {
    state.newTab({ ...newRequest('r1'), name: 'List orders' });
    state.edit({ ...state.active()!.request, url: 'https://shop.test/orders' });
    save.failWith(new Error('disk full'));
    expect(await state.saveActive(shop().id)).toBe(false);
    expect(await shown()).toContain('The request could not be saved disk full');
    expect(toast()?.getAttribute('role')).toBe('alert');
    // Said in the toast, not also in the banner.
    expect(state.error()).toBe('');
    expect(state.notice()).toBe('The request could not be saved');
    expect(state.active()?.dirty).toBe(true);
  });

  it('tells that the request was not saved when the person keeps the version changed elsewhere', async () => {
    state.newTab({ ...newRequest('r1'), name: 'List orders' });
    state.edit({ ...state.active()!.request, url: 'https://shop.test/orders' });
    save.failWith(new ApiFailure('Revision conflict', 'conflict', 409));
    state.confirm = () => false;
    expect(await state.saveActive(shop().id)).toBe(true);
    expect(await shown()).toContain(
      'Request not saved The collection changed elsewhere and was reloaded. Your changes are still in the tab.',
    );
    expect(toast()?.getAttribute('role')).toBe('status');
    expect(state.active()?.dirty).toBe(true);
  });

  it('names what each change to a collection tree did, and where', async () => {
    expect(await state.addFolder(shop(), 'Auth')).toBe(true);
    expect(await shown()).toContain('Folder added "Auth" in "Shop".');
    expect(await state.renameItem(shop(), [0], 'Sign-in')).toBe(true);
    expect(await shown()).toContain('Item renamed "Sign-in" in "Shop".');
    expect(await state.addRequest(shop(), [0])).toBe(true);
    expect(await shown()).toContain('Request added "New request" in "Shop".');
    expect(await state.dropItem(shop(), [0], [0, 0], 'after')).toBe(false);
    expect(await shown()).toContain('A folder cannot be moved into itself');
    expect(await state.removeItem(shop(), [0])).toBe(true);
    expect(await shown()).toContain('Item deleted "Sign-in" in "Shop".');

    save.failWith(new Error('disk full'));
    expect(await state.addFolder(shop(), 'Lost')).toBe(false);
    expect(await shown()).toContain('The collection could not be saved disk full');
  });

  it('saves collection settings and environments, and says when nothing was saved', async () => {
    expect(await state.saveCollectionSettings(shop().id, { variables: [] })).toBe(true);
    expect(await shown()).toContain('Collection saved "Shop"');

    const created = await state.saveEnvironment('', 'Staging', [emptyVariable()]);
    expect(created?.saved?.name).toBe('Staging');
    expect(await shown()).toContain('Environment saved "Staging"');

    save.failWith(new ApiFailure('Revision conflict', 'conflict', 409));
    state.confirm = () => false;
    expect(await state.saveEnvironment(created!.saved!.id, 'Staging', [])).toEqual({
      saved: undefined,
    });
    expect(await shown()).toContain(
      'Variables not saved They changed elsewhere and were reloaded with the latest values.',
    );

    save.failWith(new Error('disk full'));
    expect(await state.saveGlobals([])).toBeUndefined();
    expect(await shown()).toContain('The global variables could not be saved disk full');
    expect(toast()?.getAttribute('role')).toBe('alert');
  });

  it('says which file was downloaded', async () => {
    expect(await state.export(shop())).toBe(true);
    expect(api.downloads.at(-1)?.name).toBe('Shop.collection.json');
    expect(await shown()).toContain(
      'File downloaded "Shop.collection.json" was sent to your downloads folder.',
    );
    expect(
      await state.download('broken.bin', () => {
        throw new Error('The body is not valid base64');
      }),
    ).toBe(false);
    expect(await shown()).toContain(
      'The file could not be downloaded The body is not valid base64',
    );
  });

  it('shows the toast in Spanish too', async () => {
    TestBed.inject(TranslocoService).setActiveLang('es');
    state.newTab({ ...newRequest('r1'), name: 'Pedidos' });
    await state.saveActive(shop().id);
    expect(await shown()).toContain('Petición guardada «Pedidos» guardada en la colección «Shop».');
  });
});
