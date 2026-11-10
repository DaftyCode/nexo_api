import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton } from '../testing/controls';
import { ExecutionResponse } from '../domain/models';
import { ResponseView } from './response-view';

describe('ResponseView', () => {
  let component: ResponseView;
  let fixture: ComponentFixture<ResponseView>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ResponseView],
    }).compileComponents();

    fixture = TestBed.createComponent(ResponseView);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the beginning of very large bodies until asked for all of it', async () => {
    const body = 'x'.repeat(600 * 1024);
    fixture.componentRef.setInput('response', {
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'content-type', value: 'text/plain' }],
      body,
      time: 1,
      size: body.length,
    });
    await fixture.whenStable();
    const code = () => (fixture.nativeElement as HTMLElement).querySelector('.response-code')!;
    expect(code().textContent!.length).toBe(512 * 1024);
    const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (b) => b.textContent?.includes('Show full response'),
    )!;
    button.click();
    await fixture.whenStable();
    expect(code().textContent!.length).toBe(body.length);
  });

  describe('a response', () => {
    let api: TestApi;
    const root = () => fixture.nativeElement as HTMLElement;
    const tab = async (name: string) => {
      buttons(root().querySelector('.response-tabs')!, name)[0].click();
      await fixture.whenStable();
    };
    const show = async (response: Partial<ExecutionResponse>) => {
      fixture.componentRef.setInput('response', {
        status: 200,
        statusText: 'OK',
        headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true }],
        body: '{"a":1}',
        time: 12,
        size: 7,
        assertions: [],
        logs: [],
        ...response,
      });
      await fixture.whenStable();
    };
    beforeEach(() => {
      api = TestBed.inject(TEST_API);
    });

    it('asks for a PDF of the response, but not while it is being sent', async () => {
      const asked: string[] = [];
      fixture.componentInstance.exportPdf.subscribe(() => asked.push('pdf'));
      await show({});
      await clickButton(fixture, 'Export PDF');
      expect(asked).toEqual(['pdf']);
      fixture.componentRef.setInput('running', true);
      await fixture.whenStable();
      expect(root().textContent).not.toContain('Export PDF');
    });

    it('shows the body pretty or raw and downloads it', async () => {
      await show({});
      expect(root().querySelector('.response-code')?.textContent).toBe('{\n  "a": 1\n}');
      await clickButton(fixture, 'Raw');
      expect(root().querySelector('.response-code')?.textContent).toBe('{"a":1}');
      await clickButton(fixture, 'Pretty');
      await clickButton(fixture, 'Download');
      expect(api.downloads.at(-1)?.name).toBe('response.json');
    });

    it('previews images, offers other binaries for download and lists warnings', async () => {
      await show({
        headers: [{ key: 'content-type', value: 'image/png', enabled: true }],
        body: 'iVBORw0KGgo=',
        bodyEncoding: 'base64',
        warnings: ['Body truncated'],
      });
      expect(root().querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,iVBORw0KGgo=',
      );
      expect(root().textContent).toContain('Body truncated');
      await show({ headers: [], body: 'AAEC', bodyEncoding: 'base64' });
      expect(root().querySelector('img')).toBeNull();
      const [download] = buttons(root(), 'Download').slice(-1);
      download.click();
      expect(api.downloads.at(-1)?.name).toBe('response.octetstream');
    });

    it('lists headers, cookies, test results and console output', async () => {
      await show({
        cookies: [{ key: 'session', value: 'abc', enabled: true }],
        assertions: [
          { name: 'Status is 200', passed: true, skipped: false },
          { name: 'Has user', passed: false, skipped: false, error: 'Expected property user' },
        ],
        logs: [{ level: 'info', values: ['hello'] }],
      });
      await tab('Headers');
      expect(root().textContent).toContain('application/json; charset=utf-8');
      await tab('Cookies');
      expect(root().textContent).toContain('session');
      await tab('Test results');
      expect(root().textContent).toContain('Expected property user');
      expect(root().querySelector('.response-tabs')?.textContent).toContain('1/2');
      await tab('Console');
      expect(root().textContent).toContain('hello');
      await show({});
      await tab('Test results');
      expect(root().querySelector('.response-section')?.textContent).toMatch(/test/i);
      await tab('Console');
      expect(root().querySelector('.response-section')?.textContent).toMatch(/console|log/i);
    });

    it('explains errors, including a secret blocked for a host', async () => {
      await show({ status: 0, body: '', error: 'Secret api_key cannot be sent to evil.example' });
      expect(root().querySelector('.alert.error')?.textContent).toContain('api_key');
      expect(root().querySelector('.alert.error')?.textContent).toContain('evil.example');
      await show({ status: 0, body: '', error: 'connection refused' });
      expect(root().querySelector('.alert.error')?.textContent).toContain('connection refused');
      fixture.componentRef.setInput('running', true);
      await fixture.whenStable();
      expect(root().querySelector('.alert.error')).toBeNull();
    });
  });
});
