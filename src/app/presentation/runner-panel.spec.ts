import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RunnerPanel } from './runner-panel';

describe('RunnerPanel', () => {
  let component: RunnerPanel;
  let fixture: ComponentFixture<RunnerPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [RunnerPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(RunnerPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
