import { TEST_API, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton } from '../testing/controls';
import { newRequest } from '../domain/models';
import { RequestEditor } from './request-editor';
import { WorkspaceState } from './workspace-state';
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
