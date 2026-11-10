import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { clickButton } from '../testing/controls';
import { emptyAuth } from '../domain/auth';
import { ExecutionResponse, WorkspaceDocument, newRequest, row } from '../domain/models';
import { ReportPreview } from './report-preview';
import { WorkspaceState } from './workspace-state';

const response: ExecutionResponse = {
  status: 503,
  statusText: 'Unavailable',
  body: '{"error":"down"}',
  headers: [{ key: 'Set-Cookie', value: 'session=secret-cookie', enabled: true }],
  time: 40,
  size: 2048,
  assertions: [{ name: 'is up', passed: false, skipped: false, error: 'expected 200' }],
  logs: [],
  error: 'Service down',
};

describe('ReportPreview', () => {
  let fixture: ComponentFixture<ReportPreview>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const paper = () => root().querySelector('.report-paper')?.textContent ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ReportPreview],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    fixture = TestBed.createComponent(ReportPreview);
    await fixture.whenStable();
  });

  it('shows a request with its response, prints it and is released when closed', async () => {
    expect(root().querySelector('[role="dialog"]')).toBeNull();
    const request = {
      ...newRequest('r1'),
      name: 'Health',
      method: 'POST',
      url: 'https://api.test/health',
      headers: [row('Authorization', 'Bearer secret-token')],
      auth: { ...emptyAuth('bearer'), token: 'secret-token' },
      body: '{"deep":true}',
    };
    state.report.set(state.reports.requestReport(request, response));
    await fixture.whenStable();
    for (const text of [
      'Health',
      'Request and response',
      'POST',
      'https://api.test/health',
      '"deep": true',
      'Unavailable',
      'Service down',
      'is up',
      'expected 200',
      '"error": "down"',
      'Nov',
    ])
      expect(paper()).toContain(text);
    expect(paper()).not.toContain('secret-token');
    expect(paper()).not.toContain('secret-cookie');

    await clickButton(fixture, 'Print or save as PDF');
    expect(api.printed).toHaveLength(1);
    expect(api.printed[0]).toContain('Health');
    await clickButton(fixture, 'Close dialog');
    expect(state.report()).toBeUndefined();
    expect(api.released).toBe(1);
  });

  it('shows a binary response and a cut body as such', async () => {
    state.report.set(
      state.reports.requestReport(newRequest('r1'), {
        ...response,
        error: undefined,
        status: 200,
        headers: [],
        assertions: [],
        body: 'AAAA',
        bodyEncoding: 'base64',
      }),
    );
    await fixture.whenStable();
    expect(paper()).toContain('Binary response');
    state.report.set(
      state.reports.requestReport(newRequest('r1'), { ...response, body: 'x'.repeat(70_000) }),
    );
    await fixture.whenStable();
    expect(paper()).toContain('The body is cut in this report.');
  });

  it('shows a run with its totals and the tests of each request', async () => {
    state.report.set(
      state.reports.runReport(
        {
          id: 'run',
          state: 'completed',
          duration: 900,
          error: 'One request failed',
          results: [
            {
              ...response,
              name: 'Login',
              iteration: 1,
              request: { method: 'GET', url: 'https://api.test/login' },
            } as ExecutionResponse,
          ],
          assertions: [
            { name: 'status', passed: true, skipped: false, iteration: 1, request: 'Login' },
            { name: 'later', passed: true, skipped: true, iteration: 1, request: 'Login' },
            { name: 'loose', passed: false, skipped: false, error: 'no request' },
          ],
          logs: [],
        },
        'Shop',
      ),
    );
    await fixture.whenStable();
    for (const text of [
      'Shop',
      'Collection run report',
      '1 (1 failed)',
      '1 passed, 1 failed, 1 skipped',
      'One request failed',
      'Login',
      'iteration 2',
      'PASS · status',
      'SKIP · later',
      'Other tests',
      'FAIL · loose',
      'no request',
    ])
      expect(paper()).toContain(text);
  });

  it('shows the documentation of a collection, and an error when it cannot print', async () => {
    const document: WorkspaceDocument = {
      id: 'c1',
      workspace_id: 'local',
      kind: 'collection',
      name: 'Shop',
      revision: 1,
      updated_at: 0,
      value: {
        info: { name: 'Shop', schema: 'x', description: 'The shop API' },
        auth: { type: 'bearer' },
        variable: [{ key: 'token', value: 'secret-variable' }],
        item: [
          {
            name: 'Orders',
            description: 'Order endpoints',
            item: [
              {
                name: 'List orders',
                request: {
                  method: 'GET',
                  url: { raw: 'https://api.test/orders?page=1' },
                  description: 'All orders',
                  header: [{ key: 'Accept', value: 'application/json' }],
                  body: { mode: 'raw', raw: '{"filter":1}' },
                  auth: { type: 'apikey', apikey: [] },
                },
                response: [{ name: 'Found', code: 200, body: '"ok"' }],
              },
            ],
          },
        ],
      },
    };
    state.report.set(state.reports.collectionDocs(document));
    await fixture.whenStable();
    for (const text of [
      'Collection documentation',
      'The shop API',
      'bearer',
      'Orders',
      'Order endpoints',
      'List orders',
      'All orders',
      '?page',
      'Accept',
      '"filter": 1',
      'apikey',
      'Example: Found 200',
    ])
      expect(paper()).toContain(text);
    expect(paper()).not.toContain('secret-variable');

    api.printed.push = () => {
      throw new Error('No printer');
    };
    await clickButton(fixture, 'Print or save as PDF');
    expect(state.error()).toBe('No printer');
  });
});
