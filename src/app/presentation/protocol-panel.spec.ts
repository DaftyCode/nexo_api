import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProtocolPanel } from './protocol-panel';

describe('ProtocolPanel', () => {
  let component: ProtocolPanel;
  let fixture: ComponentFixture<ProtocolPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ProtocolPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(ProtocolPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
