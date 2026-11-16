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
