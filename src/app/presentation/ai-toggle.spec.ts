import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton } from '../testing/controls';
import { testProviders } from '../testing/providers';
import { AiToggle } from './ai-toggle';

describe('AiToggle', () => {
  let fixture: ComponentFixture<AiToggle>;
  const button = () => (fixture.nativeElement as HTMLElement).querySelector('button')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [AiToggle],
    }).compileComponents();
    fixture = TestBed.createComponent(AiToggle);
    await fixture.whenStable();
  });

  it('opens and closes the assistant, pressed while it is open, with its own icon', async () => {
    const seen: boolean[] = [];
    fixture.componentInstance.open.subscribe((open) => seen.push(open));
    expect(button().textContent?.trim()).toBe('AI assistant');
    expect(button().querySelector('app-studio-icon')?.getAttribute('name')).toBe('sparkles');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().classList).not.toContain('small');
    await clickButton(fixture, /^AI assistant$/);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await clickButton(fixture, /^AI assistant$/);
    expect(seen).toEqual([true, false]);
  });

  it('takes the size of a dense toolbar', async () => {
    fixture.componentRef.setInput('small', '');
    await fixture.whenStable();
    expect(button().classList).toContain('small');
  });
});
