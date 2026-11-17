import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { clickButton, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { DocumentRevisions } from './document-revisions';
import { PanelTask } from './panel-task';
import { WorkspaceState } from './workspace-state';

describe('DocumentRevisions', () => {
  let fixture: ComponentFixture<DocumentRevisions>;
  let api: TestApi;
  let state: WorkspaceState;
  let task: PanelTask;
  const output = signal('');
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DocumentRevisions],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    task = new PanelTask(state);
    output.set('');
    fixture = TestBed.createComponent(DocumentRevisions);
    fixture.componentRef.setInput('task', task);
    fixture.componentRef.setInput('output', output);
    await fixture.whenStable();
  });

  it('lists the documents with their revision and the history of the one chosen', async () => {
    await state.createCollection('Orders');
    const [collection] = state.collections();
    const asked: string[] = [];
    api.revisions = async (id: string) => {
      asked.push(id);
      return [
        { revision: 2, changed_at: 0, value: collection },
        { revision: 1, changed_at: 0, value: collection },
      ];
    };
    await settle();
    expect(root().textContent).toContain('Document history');
    expect(root().querySelectorAll('option')).toHaveLength(1 + state.documents().length);

    await fill(fixture, 'Document', collection.id);
    await clickButton(fixture, 'Load revisions');
    await settle();
    expect(asked).toEqual([collection.id]);
    expect(root().querySelectorAll('.run-result')).toHaveLength(2);
  });

  it('restores a revision as a new one and says so in the panel and a toast', async () => {
    await state.createCollection('Orders');
    const [collection] = state.collections();
    api.revisions = async () => [{ revision: 1, changed_at: 0, value: collection }];
    await settle();
    await fill(fixture, 'Document', collection.id);
    await clickButton(fixture, 'Load revisions');
    await settle();
    await clickButton(fixture, 'Restore as new revision');
    await settle();
    expect(output()).toBe('Revision restored as a new revision.');
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Revision restored',
      params: { v0: 'Orders' },
    });
  });

  it('shows in the panel why the history could not be read', async () => {
    await clickButton(fixture, 'Load revisions');
    await settle();
    expect(task.error()).toBe('Choose a resource');

    await state.createCollection('Orders');
    api.revisions = async () => {
      throw new Error('The document does not exist');
    };
    await settle();
    await fill(fixture, 'Document', state.collections()[0].id);
    await clickButton(fixture, 'Load revisions');
    await settle();
    expect(task.error()).toContain('The document does not exist');
    expect(root().querySelectorAll('.run-result')).toHaveLength(0);
  });
});
