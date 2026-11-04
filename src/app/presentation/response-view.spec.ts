import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
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
});
