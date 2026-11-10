import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, exerciseControls, fill } from '../testing/controls';
import { newRequest } from '../domain/models';
import { readAuth } from '../domain/auth';
import { RequestEditor } from './request-editor';
import { WorkspaceState } from './workspace-state';
import { TEST_API } from '../testing/providers';
import { introspection } from '../testing/graphql';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import { GraphqlQueryEditor } from './graphql-query-editor';

describe('RequestEditor', () => {
  let component: RequestEditor;
  let fixture: ComponentFixture<RequestEditor>;
  const root = () => fixture.nativeElement as HTMLElement;
  const tab = async (name: string) => {
    const [button] = buttons(root().querySelector('.editor-tabs')!, name);
    button.click();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [RequestEditor],
    }).compileComponents();

    fixture = TestBed.createComponent(RequestEditor);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('edits every part of the request in its tabs', async () => {
    fixture.componentRef.setInput('request', {
      ...newRequest('r1'),
      url: 'https://api.example.com/users/:id',
    });
    await fixture.whenStable();
    expect(root().textContent).toContain('Path variables');

    for (const name of ['Params', 'Headers', 'Body', 'Scripts', 'Settings']) {
      await tab(name);
      const unchanged = await exerciseControls(fixture, () => component.request(), {
        root: root().querySelector('.request-content')!,
      });
      expect(unchanged, name).toEqual([]);
    }
    const toolbar = await exerciseControls(fixture, () => component.request(), {
      skip: (control) => !!control.closest('.request-content'),
    });
    expect(toolbar).toEqual([]);
    const request = component.request();
    expect(request.name).not.toBe('New request');
  });

  it('edits the values of the path variables in the URL', async () => {
    fixture.componentRef.setInput('request', {
      ...newRequest('r1'),
      url: 'https://api.example.com/users/:id',
    });
    await fixture.whenStable();
    const [, path] = root().querySelectorAll('app-key-value-editor');
    const inputs = [...path.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')];
    const value = inputs.find(
      (input) => !input.disabled && !input.readOnly && input.value !== 'id',
    )!;
    value.value = '42';
    value.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(component.request().pathVariables).toContainEqual(
      expect.objectContaining({ key: 'id', value: '42' }),
    );
  });

  it('switches body types, formats JSON and keeps unknown imported types', async () => {
    fixture.componentRef.setInput('request', { ...newRequest('r1'), bodyMode: 'other-tool' });
    await tab('Body');
    expect(root().textContent).toContain('This body type is not edited in Nexo');
    component.request.update((r) => ({ ...r, protocol: 'graphql' }));
    await fixture.whenStable();
    expect(root().querySelector('[aria-label="GraphQL variables"]')).not.toBeNull();

    component.request.update((r) => ({ ...r, bodyMode: 'raw', protocol: 'http', body: '{"a":1}' }));
    await fixture.whenStable();
    await clickButton(fixture, 'Beautify');
    expect(component.request().body).toBe('{\n  "a": 1\n}');

    component.request.update((r) => ({ ...r, bodyMode: 'none' }));
    await fixture.whenStable();
    expect(root().textContent).toContain('This request does not have a body.');
    component.request.update((r) => ({ ...r, bodyMode: 'formdata' }));
    await fixture.whenStable();
    expect(root().querySelector('app-key-value-editor')).not.toBeNull();
  });

  it('writes pre-request and test scripts and adds a test snippet', async () => {
    await tab('Scripts');
    await clickButton(fixture, 'Status assertion');
    expect(component.request().tests).toContain('Response is successful');
    const [pre] = buttons(root(), 'Pre-request');
    pre.click();
    await fixture.whenStable();
    await fill(fixture, 'Pre-request scripts', 'pm.environment.set("a", 1);');
    expect(component.request().prerequest).toBe('pm.environment.set("a", 1);');
  });

  it('edits the authorization and forwards its token requests', async () => {
    const tokens: boolean[] = [];
    let edits = 0;
    component.oauth2Token.subscribe((refresh) => tokens.push(refresh));
    component.editInheritedAuth.subscribe(() => edits++);
    fixture.componentRef.setInput('inheritance', {});
    await tab('Authorization');
    await clickButton(fixture, 'Set an authorization for the collection');
    expect(edits).toBe(1);
    component.request.update((r) => ({
      ...r,
      auth: readAuth({
        type: 'oauth2',
        oauth2: [{ key: 'grant_type', value: 'client_credentials' }],
      }),
    }));
    await fixture.whenStable();
    await clickButton(fixture, 'Get new access token');
    expect(tokens).toEqual([false]);
    const type = [...root().querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'bearer'),
    )!;
    type.value = 'bearer';
    type.dispatchEvent(new Event('change'));
    type.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(component.request().auth.type).toBe('bearer');
  });

  it('shows the variables it uses and emits its actions', async () => {
    const emitted: string[] = [];
    component.send.subscribe(() => emitted.push('send'));
    component.cancelRequest.subscribe(() => emitted.push('cancel'));
    component.save.subscribe(() => emitted.push('save'));
    component.code.subscribe(() => emitted.push('code'));
    component.cookies.subscribe(() => emitted.push('cookies'));
    component.manageVariables.subscribe(() => emitted.push('variables'));
    fixture.componentRef.setInput('variables', [
      {
        name: 'host',
        defined: true,
        scope: 'environment',
        value: 'api.example.com',
        secret: false,
      },
      { name: 'token', defined: true, scope: 'environment', value: 'x', secret: true },
      { name: '$guid', defined: true, scope: 'dynamic', secret: false },
      { name: 'vault:key', defined: true, scope: 'vault', secret: true },
      { name: 'missing', defined: false, secret: false },
    ]);
    component.request.update((r) => ({
      ...r,
      headers: [
        { key: 'A', value: '1', enabled: true },
        { key: 'B', value: '2', enabled: true },
      ],
    }));
    await fixture.whenStable();
    const strip = root().querySelector('[aria-label="Variables used by this request"]')!;
    expect(strip.textContent).toContain('host');
    const titles = [...strip.querySelectorAll('[title]')].map((element) =>
      element.getAttribute('title'),
    );
    expect(titles).toEqual(
      expect.arrayContaining([
        'api.example.com',
        '••••••••',
        'Generated for each request',
        'Resolved from your vault when sent',
        'Not defined in the active environment, collection or globals',
      ]),
    );
    (strip.querySelector('button') as HTMLButtonElement).click();
    await clickButton(fixture, 'Cookies');
    await clickButton(fixture, 'Code');
    await clickButton(fixture, 'Save');
    await clickButton(fixture, 'Send');
    fixture.componentRef.setInput('running', true);
    await fixture.whenStable();
    await clickButton(fixture, 'Cancel');
    expect(emitted).toEqual(['variables', 'cookies', 'code', 'save', 'send', 'cancel']);
    expect(root().querySelector('.editor-tabs .count')?.textContent).toBe('2');
  });

  it('chooses files for form-data fields and a binary body', async () => {
    const choose = async (input: HTMLInputElement, files: File[]) => {
      Object.defineProperty(input, 'files', { value: files, configurable: true });
      input.dispatchEvent(new Event('change'));
      for (let i = 0; i < 4; i++) await fixture.whenStable();
    };
    fixture.componentRef.setInput('request', {
      ...newRequest('r1'),
      method: 'POST',
      bodyMode: 'formdata',
      form: [{ key: 'avatar', value: '', enabled: true }],
    });
    await tab('Body');
    const type = root().querySelector<HTMLSelectElement>('[aria-label="Field type"]')!;
    type.value = 'file';
    type.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(component.request().form[0]).toMatchObject({ key: 'avatar', type: 'file', src: '' });
    const files = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    await choose(files, [
      new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ]);
    const [row] = component.request().form;
    expect(row.src).toEqual(['a.png', 'b.txt']);
    expect(
      row.files?.map((file) => [file.name, file.contentType, file.size, file.content]),
    ).toEqual([
      ['a.png', 'image/png', 3, 'AQID'],
      ['b.txt', 'text/plain', 1, 'Yg=='],
    ]);
    expect(root().querySelector('.kv-file-names')?.textContent).toBe('a.png, b.txt');

    // A saved request keeps the names only: the files are asked for again.
    component.request.update((r) => ({ ...r, form: [{ ...r.form[0], files: undefined }] }));
    await fixture.whenStable();
    expect(root().querySelector('.kv-file-missing')?.textContent).toContain('a.png, b.txt');
    type.value = 'text';
    type.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    const text = component.request().form[0];
    expect([text.key, text.value, text.type, text.src, text.files]).toEqual([
      'avatar',
      '',
      undefined,
      undefined,
      undefined,
    ]);

    const mode = root().querySelector<HTMLSelectElement>('.body-options select')!;
    mode.value = 'file';
    mode.dispatchEvent(new Event('input'));
    mode.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(root().textContent).toContain('The bytes of the file are sent as the body.');
    await choose(root().querySelector<HTMLInputElement>('.binary-body input')!, [
      new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }),
    ]);
    expect(component.request().bodyFile).toMatchObject({
      src: 'doc.pdf',
      file: { name: 'doc.pdf', contentType: 'application/pdf', content: 'JVBERg==' },
    });
    component.request.update((r) => ({ ...r, bodyFile: { src: 'doc.pdf' } }));
    await fixture.whenStable();
    expect(root().querySelector('.binary-missing')?.textContent).toContain('doc.pdf');
  });

  it('edits a GraphQL body and inserts fields from the loaded schema', async () => {
    const state = TestBed.inject(WorkspaceState);
    const api = TestBed.inject(TEST_API);
    api.responses['request'] = ({ request }: Record<string, unknown>) => ({
      status: 200,
      statusText: 'OK',
      headers: [],
      body: JSON.stringify(introspection),
      time: 1,
      size: 1,
      assertions: [],
      logs: [],
      sent: request,
    });
    const request = { ...newRequest('g1'), method: 'POST', url: 'https://api.test/graphql' };
    state.newTab(request);
    fixture.componentRef.setInput('request', request);
    await tab('Body');
    const mode = root().querySelector<HTMLSelectElement>('.body-options select')!;
    mode.value = 'graphql';
    mode.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(component.request()).toMatchObject({ protocol: 'graphql', bodyMode: 'raw' });
    expect(mode.value).toBe('graphql');
    expect(root().textContent).not.toContain('Beautify');

    await clickButton(fixture, 'Load schema');
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    const sent = api.calls.find((call) => call.operation === 'request')!.payload;
    expect(JSON.stringify(sent['request'])).toContain('IntrospectionQuery');
    expect(state.graphqlSchemas()['https://api.test/graphql']?.queryType).toBe('Query');
    expect(root().textContent).toContain('user(id: ID!): User');

    // The query editor loads apart (@defer) and takes the schema loaded.
    await vi.waitFor(() =>
      expect(root().querySelector('[aria-label="GraphQL query"]')).not.toBeNull(),
    );
    const editor = fixture.debugElement.query(By.directive(GraphqlQueryEditor))
      .componentInstance as GraphqlQueryEditor;
    const view = editor.editor()!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'query {\n  \n}' } });
    await fixture.whenStable();
    expect(component.request().body).toBe('query {\n  \n}');
    view.dispatch({ selection: { anchor: 10 } });
    buttons(root(), 'Insert')[0].click();
    await fixture.whenStable();
    expect(component.request().body).toBe('query {\n  user(id: $id) {\n  \n}\n}');

    mode.value = 'formdata';
    mode.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(component.request()).toMatchObject({ protocol: 'http', bodyMode: 'formdata' });
  });

  it('refuses files above the request limit', async () => {
    const state = TestBed.inject(WorkspaceState);
    fixture.componentRef.setInput('request', { ...newRequest('r1'), bodyMode: 'file' });
    await tab('Body');
    const input = root().querySelector<HTMLInputElement>('.binary-body input')!;
    const big = new File(['x'], 'big.bin');
    Object.defineProperty(big, 'size', { value: 33 * 1024 * 1024 });
    Object.defineProperty(input, 'files', { value: [big] });
    input.dispatchEvent(new Event('change'));
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    expect(state.error()).toBe('Files sent with a request can add up to 32 MB');
    expect(component.request().bodyFile).toBeUndefined();
  });
});
