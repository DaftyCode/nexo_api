import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton, exerciseControls, fill } from '../testing/controls';
import { newRequest } from '../domain/models';
import { readAuth } from '../domain/auth';
import { RequestEditor } from './request-editor';

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
});
