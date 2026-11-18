import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { AppearanceState } from './appearance-state';
import { Home } from './home';

describe('Home', () => {
  let fixture: ComponentFixture<Home>;
  const website = () => (fixture.nativeElement as HTMLElement).querySelector('.website')!;

  async function open(page?: string) {
    await TestBed.configureTestingModule({
      providers: [
        ...testProviders(),
        { provide: ActivatedRoute, useValue: { snapshot: { data: page ? { page } : {} } } },
      ],
      imports: [Home],
    }).compileComponents();
    fixture = TestBed.createComponent(Home);
    await fixture.whenStable();
  }

  it('shows the home page in the colours of the template chosen in the app', async () => {
    await open();
    expect(website().getAttribute('data-theme')).toBe('aurora');
    expect(website().classList.contains('docs-site')).toBe(false);
    expect(website().querySelector('.site-hero')).not.toBeNull();
    TestBed.inject(AppearanceState).model.set({ template: 'canvas' });
    await fixture.whenStable();
    expect(website().getAttribute('data-theme')).toBe('canvas');
  });

  it('shows the documentation at the full width, also in the template colours', async () => {
    await open('docs');
    expect(website().classList.contains('docs-site')).toBe(true);
    expect(website().querySelector('app-docs-page .docs-index')).not.toBeNull();
    expect(website().querySelector('.site-hero')).toBeNull();
    TestBed.inject(AppearanceState).model.set({ template: 'aurora-color' });
    await fixture.whenStable();
    expect(website().getAttribute('data-theme')).toBe('aurora-color');
  });
});
