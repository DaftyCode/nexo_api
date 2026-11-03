import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KeyValueEditor } from './key-value-editor';

describe('KeyValueEditor', () => {
  let component: KeyValueEditor;
  let fixture: ComponentFixture<KeyValueEditor>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [KeyValueEditor],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyValueEditor);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
