import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ResponseView } from './response-view';

describe('ResponseView', () => {
  let component: ResponseView;
  let fixture: ComponentFixture<ResponseView>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [ResponseView],
    }).compileComponents();

    fixture = TestBed.createComponent(ResponseView);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
