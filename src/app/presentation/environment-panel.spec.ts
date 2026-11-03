import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EnvironmentPanel } from './environment-panel';

describe('EnvironmentPanel', () => {
  let component: EnvironmentPanel;
  let fixture: ComponentFixture<EnvironmentPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [EnvironmentPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(EnvironmentPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
