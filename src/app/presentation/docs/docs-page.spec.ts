import { ComponentFixture, TestBed } from '@angular/core/testing';
import { testProviders } from '../../testing/providers';
import { DocsPage } from './docs-page';

describe('DocsPage', () => {
  let fixture: ComponentFixture<DocsPage>;
  const root = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DocsPage],
    }).compileComponents();
    fixture = TestBed.createComponent(DocsPage);
    await fixture.whenStable();
  });

  it('lists every section in its index, and every entry leads to its section', () => {
    const links = [...root().querySelectorAll<HTMLAnchorElement>('.docs-index a')];
    expect(links.length).toBe(23);
    for (const link of links)
      expect(root().querySelector(`main ${link.getAttribute('href')}`)?.tagName).toBe('SECTION');
    expect(root().querySelectorAll('main.docs section').length).toBe(links.length);
    expect(root().querySelector('nav.docs-index')?.getAttribute('aria-label')).toBe(
      'Documentation contents',
    );
  });

  it('scrolls to a section from the index without leaving the page', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      const link = root().querySelector<HTMLAnchorElement>('.docs-index a[href="#databases"]')!;
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      await fixture.whenStable();
      expect(click.defaultPrevented).toBe(true);
      expect(scrolled).toEqual(['databases']);
      expect(link.classList.contains('active')).toBe(true);
      expect(root().querySelectorAll('.docs-index a.active').length).toBe(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('tells what Nexo keeps on the computer and lists the keyboard shortcuts', () => {
    const storage = root().querySelector('#storage')?.textContent ?? '';
    for (const limit of ['200 entries and 20 MB', 'the last 20', '25 per document', '10 MB'])
      expect(storage).toContain(limit);
    expect(root().querySelectorAll('#shortcuts tbody tr').length).toBe(10);
    expect(root().querySelector('#vault code')?.textContent).toBe('{{vault:name}}');
  });
});
