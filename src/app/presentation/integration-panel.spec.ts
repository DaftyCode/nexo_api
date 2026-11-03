import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IntegrationPanel } from './integration-panel';

describe('IntegrationPanel', () => {
  let component: IntegrationPanel;
  let fixture: ComponentFixture<IntegrationPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [IntegrationPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(IntegrationPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
