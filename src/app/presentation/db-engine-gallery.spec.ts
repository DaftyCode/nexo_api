import { ComponentFixture, TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { ModuleSummary } from '../domain/modules';
import { DbEngineGallery, engineIcon } from './db-engine-gallery';

const summary = (id: string, name: string, state: ModuleSummary['state']): ModuleSummary => ({
  id,
  name,
  description: `${name} from its manifest`,
  version: '0.7.0',
  state,
  downloadSize: 2_000_000,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
});

describe('DbEngineGallery', () => {
  let fixture: ComponentFixture<DbEngineGallery>;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const cards = () => [...root().querySelectorAll<HTMLButtonElement>('.db-engine')];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [
          summary('mysql', 'MySQL', 'available'),
          summary('postgres', 'PostgreSQL', 'installed'),
          summary('graph', 'Graph', 'available'),
        ],
      }),
      imports: [DbEngineGallery],
    }).compileComponents();
    fixture = TestBed.createComponent(DbEngineGallery);
    await settle();
  });

  it('shows each engine with the icon its driver brings, what it is and its state', async () => {
    const [postgres, graph, mysql] = cards();
    // The installed ones first, then by name.
    expect(postgres.textContent).toContain('PostgreSQL');
    expect(postgres.textContent).toContain('Popular');
    expect(postgres.textContent).toContain('Installed');
    expect(postgres.querySelector('img')?.getAttribute('src')).toBe(engineIcon('postgres'));
    expect(engineIcon('postgres')).toBe('engines/nexo-driver-postgres/icon.svg');
    expect(mysql.textContent).toContain('MySQL, MariaDB');
    expect(mysql.textContent).toMatch(/Download.*MB/);
    // A module the interface does not know keeps its manifest's words, and the plain icon
    // when its driver brings none.
    expect(graph.textContent).toContain('Graph from its manifest');
    expect(graph.querySelector('.db-engine-badge')).toBeNull();
    graph.querySelector('img')!.dispatchEvent(new Event('error'));
    await settle();
    expect(cards()[1].querySelector('img')).toBeNull();
    expect(cards()[1].querySelector('app-studio-icon')).not.toBeNull();
    expect(root().textContent).toContain('More soon');
  });

  it('finds an engine by what it is, and hides what is to come while searching', async () => {
    const search = root().querySelector<HTMLInputElement>('.db-gallery-search input')!;
    search.value = 'mariadb';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(cards().map((card) => card.querySelector('strong')?.textContent)).toEqual(['MySQL']);
    expect(root().textContent).not.toContain('More soon');
    let chosen: ModuleSummary | undefined;
    fixture.componentInstance.chosen.subscribe((module) => (chosen = module));
    cards()[0].click();
    expect(chosen?.id).toBe('mysql');
  });
});
