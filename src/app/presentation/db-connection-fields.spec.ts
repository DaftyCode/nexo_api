import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { DATABASE_FILES } from '../composition/providers';
import { engineProfile } from '../domain/db/engines';
import { DbForm, emptyDbForm } from '../domain/db/form';
import { testProviders } from '../testing/providers';
import { buttons } from '../testing/controls';
import { DbConnectionFields } from './db-connection-fields';

@Component({
  imports: [DbConnectionFields],
  template: `<app-db-connection-fields page="main" [fields]="fields" [profile]="profile" />`,
})
class Host {
  readonly model = signal<DbForm>(emptyDbForm('sqlite', 'Shop'));
  readonly fields = form(this.model);
  readonly profile = engineProfile('sqlite');
}

describe('DbConnectionFields of a SQLite connection', () => {
  let fixture: ComponentFixture<Host>;
  const chosen: boolean[] = [];
  const root = () => fixture.nativeElement as HTMLElement;

  const render = async (available: boolean) => {
    await TestBed.configureTestingModule({
      providers: [
        ...testProviders(),
        {
          provide: DATABASE_FILES,
          useValue: {
            available,
            choose: async (create: boolean) => {
              chosen.push(create);
              return create ? '/home/ana/new.db' : '/home/ana/shop.db';
            },
          },
        },
      ],
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('asks for the file, chosen in the desktop dialog or made new', async () => {
    await render(true);
    expect(root().textContent).toContain('Database file');
    expect(root().textContent).not.toContain('Password');
    buttons(root(), 'Open…')[0].click();
    await fixture.whenStable();
    expect(fixture.componentInstance.model().database).toBe('/home/ana/shop.db');
    expect(fixture.componentInstance.model().params).toEqual([]);
    buttons(root(), 'New file…')[0].click();
    await fixture.whenStable();
    expect(chosen).toEqual([false, true]);
    expect(fixture.componentInstance.model().database).toBe('/home/ana/new.db');
    // Signal Forms marks each row of a list with a symbol of its own: compare what it holds.
    const params = fixture.componentInstance
      .model()
      .params.map(({ name, value }) => ({ name, value }));
    expect(params).toEqual([{ name: 'create', value: 'true' }]);
  });

  it('is typed in the web version, which has no dialog', async () => {
    await render(false);
    expect(root().textContent).toContain('Database file');
    expect(buttons(root(), 'Open…')).toEqual([]);
  });
});

@Component({
  imports: [DbConnectionFields],
  template: `@for (page of pages; track page) {
    <section [attr.data-page]="page">
      <app-db-connection-fields [page]="page" [fields]="fields" [profile]="profile" />
    </section>
  }`,
})
class Pages {
  readonly pages = ['main', 'tls', 'properties', 'general'] as const;
  readonly model = signal<DbForm>(emptyDbForm('postgres', 'Shop'));
  readonly fields = form(this.model);
  readonly profile = engineProfile('postgres');
}

describe('DbConnectionFields of a server connection', () => {
  let fixture: ComponentFixture<Pages>;
  const page = (name: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-page="${name}"]`)!;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Pages],
    }).compileComponents();
    fixture = TestBed.createComponent(Pages);
    await settle();
  });

  it('shows the server, TLS and general fields', async () => {
    expect(page('main').textContent).toContain('Host');
    expect(page('main').textContent).toContain('Password');
    expect(page('tls').textContent).toContain('Certificate authority (PEM)');
    expect(page('general').textContent).toContain('Connection type');
  });

  it('adds the driver settings it accepts, one of each, and removes them', async () => {
    const model = () => fixture.componentInstance.model();
    for (let i = 0; i < 3; i++) {
      buttons(page('properties'), '+ Add setting')[0]?.click();
      await settle();
    }
    expect(model().params.map((row) => row.name)).toEqual([
      'application_name',
      'options',
      'search_path',
    ]);
    expect(buttons(page('properties'), '+ Add setting')).toEqual([]);
    const remove = page('properties').querySelector<HTMLButtonElement>(
      'button[aria-label^="Remove"]',
    );
    remove?.click();
    await settle();
    expect(model().params.map((row) => row.name)).toEqual(['options', 'search_path']);
  });

  it('chooses a color and takes it away', async () => {
    const swatches = page('general').querySelectorAll<HTMLButtonElement>('.db-swatch:not(.none)');
    swatches[0].click();
    await settle();
    expect(fixture.componentInstance.model().color).not.toBe('');
    buttons(page('general'), 'No color')[0].click();
    await settle();
    expect(fixture.componentInstance.model().color).toBe('');
  });
});
