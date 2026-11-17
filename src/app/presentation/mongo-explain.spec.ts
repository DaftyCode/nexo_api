import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { buttons } from '../testing/controls';
import { testProviders } from '../testing/providers';
import { MongoExplain } from './mongo-explain';

@Component({
  imports: [MongoExplain],
  template: `<app-mongo-explain [explain]="explain()" />`,
})
class Host {
  readonly explain = signal<unknown>({});
}

/** A sharded plan of the slot-based engine, measured, with a rejected plan. */
const sharded = {
  queryPlanner: {
    winningPlan: {
      queryPlan: {
        stage: 'SHARD_MERGE',
        planNodeId: 3,
        shards: [
          {
            shardName: 'shard-a',
            winningPlan: {
              queryPlan: { stage: 'IXSCAN', planNodeId: 1, indexName: 'city_1' },
            },
          },
        ],
      },
    },
    rejectedPlans: [{ stage: 'COLLSCAN' }],
  },
  executionStats: {
    executionStages: { stage: 'ixseek', planNodeId: 1, keysExamined: 4, nReturned: 2 },
  },
};

describe('the explain of a MongoDB query', () => {
  let fixture: ComponentFixture<Host>;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Host],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('shows an unmeasured plan with dashes, and its JSON', async () => {
    fixture.componentInstance.explain.set({ queryPlanner: { winningPlan: { stage: 'FETCH' } } });
    await settle();
    expect(root().textContent).toContain('Planned only');
    fixture.componentInstance.explain.set({
      queryPlanner: { winningPlan: { stage: 'FETCH' } },
      executionStats: { executionStages: { stage: 'FETCH' } },
    });
    await settle();
    expect(root().textContent).toContain('—');
    buttons(root(), 'JSON')[0].click();
    await settle();
    expect(root().textContent).toContain('queryPlanner');
    buttons(root(), 'Stages')[0].click();
    await settle();
    expect(root().textContent).toContain('FETCH');
  });

  it('shows the shards, the index, the keys examined and the rejected plans', async () => {
    fixture.componentInstance.explain.set(sharded);
    await settle();
    const text = root().textContent ?? '';
    expect(text).toContain('city_1');
    expect(text).toMatch(/shard-a|IXSCAN/);
    expect(text).toMatch(/1/);
  });
});
