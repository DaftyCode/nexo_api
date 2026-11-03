import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RequestEditor } from './request-editor';

describe('RequestEditor', () => {
  let component: RequestEditor;
  let fixture: ComponentFixture<RequestEditor>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [RequestEditor],
    }).compileComponents();

    fixture = TestBed.createComponent(RequestEditor);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
