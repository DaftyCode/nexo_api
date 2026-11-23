import { ComponentFixture, TestBed } from '@angular/core/testing';
import { buttons, clickButton } from '../../testing/controls';
import { testProviders } from '../../testing/providers';
import { DbSqlSides } from './sides';

describe('DbSqlSides', () => {
  let fixture: ComponentFixture<DbSqlSides>;
  const root = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DbSqlSides],
    }).compileComponents();
    fixture = TestBed.createComponent(DbSqlSides);
    await fixture.whenStable();
  });

  it('opens one panel at a time, a second click closing it, without the assistant', async () => {
    expect([...root().querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      'History',
      'Variables',
      'Outline',
      'Templates',
    ]);
    await clickButton(fixture, 'History');
    expect(fixture.componentInstance.side()).toBe('history');
    expect(buttons(root(), 'History')[0].getAttribute('aria-pressed')).toBe('true');
    await clickButton(fixture, 'Outline');
    expect(fixture.componentInstance.side()).toBe('outline');
    expect(buttons(root(), 'History')[0].getAttribute('aria-pressed')).toBe('false');
    await clickButton(fixture, 'Outline');
    expect(fixture.componentInstance.side()).toBe('');
  });
});
