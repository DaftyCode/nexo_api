import { ComponentFixture, TestBed } from '@angular/core/testing';
import { testProviders } from '../testing/providers';
import { introspection } from '../testing/graphql';
import { buttons, clickButton } from '../testing/controls';
import { readSchema } from '../domain/graphql-schema';
import { GraphqlExplorer } from './graphql-explorer';

describe('GraphqlExplorer', () => {
  let fixture: ComponentFixture<GraphqlExplorer>;
  const root = () => fixture.nativeElement as HTMLElement;
  const inserted: string[] = [];
  let loads = 0;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [GraphqlExplorer],
    }).compileComponents();
    fixture = TestBed.createComponent(GraphqlExplorer);
    inserted.length = 0;
    loads = 0;
    fixture.componentInstance.insert.subscribe((text) => inserted.push(text));
    fixture.componentInstance.loadSchema.subscribe(() => loads++);
    await fixture.whenStable();
  });

  it('asks to load the schema and says when it is loading', async () => {
    expect(root().textContent).toContain('Load the schema to browse its types');
    await clickButton(fixture, 'Load schema');
    expect(loads).toBe(1);
    fixture.componentRef.setInput('loading', true);
    await fixture.whenStable();
    expect(buttons(root(), 'Loading schema')[0].disabled).toBe(true);
  });

  it('browses the root types, opens field types and inserts fields', async () => {
    fixture.componentRef.setInput('schema', readSchema(JSON.stringify(introspection)));
    await fixture.whenStable();
    expect(root().querySelector('h3')?.textContent).toContain('Query');
    expect(root().textContent).toContain('user(id: ID!): User');
    expect(root().querySelector('.deprecated .badge')?.getAttribute('title')).toBe('Use search');

    buttons(root(), 'Insert')[0].click();
    expect(inserted).toEqual(['user(id: $id) {\n  \n}']);

    await clickButton(fixture, /^\s*User\s*$/);
    expect(root().querySelector('h3')?.textContent).toContain('User');
    expect(root().textContent).toContain('Someone who signs in');
    await clickButton(fixture, /^\s*Role\s*$/);
    expect(root().textContent).toContain('ADMIN');
    expect(buttons(root(), 'Insert')).toEqual([]);
    await clickButton(fixture, 'Back');
    await clickButton(fixture, 'Back');
    expect(root().querySelector('h3')?.textContent).toContain('Query');

    await clickButton(fixture, /^\s*Mutation\s*$/);
    expect(root().textContent).toContain('rename(input: RenameInput!, notify: Boolean): Boolean');
  });

  it('searches types and fields', async () => {
    fixture.componentRef.setInput('schema', readSchema(JSON.stringify(introspection)));
    await fixture.whenStable();
    const search = root().querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'rename';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root().textContent).toContain('Mutation.rename');
    expect(root().textContent).toContain('RenameInput');
    buttons(root(), 'Insert')[0].click();
    expect(inserted).toEqual(['rename(input: $input, notify: $notify)']);
    await clickButton(fixture, 'RenameInput');
    expect(root().querySelector('h3')?.textContent).toContain('RenameInput');
    expect(root().textContent).toContain('name: String!');

    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(root().textContent).toContain('Nothing matches.');
  });
});
