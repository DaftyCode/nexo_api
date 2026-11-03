import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToolsPanel } from './tools-panel';

describe('ToolsPanel', () => {
  let component: ToolsPanel;
  let fixture: ComponentFixture<ToolsPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ToolsPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(ToolsPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
