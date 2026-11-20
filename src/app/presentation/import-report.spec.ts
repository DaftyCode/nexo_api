import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { testProviders } from '../testing/providers';
import { ImportReport } from '../domain/import-report';
import { ImportReportView } from './import-report';

describe('ImportReportView', () => {
  const show = async (report: ImportReport) => {
    TestBed.configureTestingModule({ providers: testProviders(), imports: [ImportReportView] });
    const fixture = TestBed.createComponent(ImportReportView);
    fixture.componentRef.setInput('report', report);
    await fixture.whenStable();
    return fixture;
  };

  it('says what came and lists, a kind at a time, what did not come as it was', async () => {
    const fixture = await show({
      source: 'Insomnia',
      requests: 12,
      folders: 3,
      environments: 2,
      notes: [
        { code: 'script', items: Array.from({ length: 13 }, (_, at) => `Request ${at + 1}`) },
        { code: 'file', items: ['Upload'] },
      ],
    });
    const text = () =>
      ((fixture.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ');
    expect(text()).toContain('Imported from Insomnia. Requests: 12, folders: 3, environments: 2.');
    expect(text()).toContain('Scripts commented out, to translate to pm.*:');
    expect(text()).toContain('Request 10 and 3 more');
    expect(text()).not.toContain('Request 11');
    expect(text()).toContain('Files to choose again: Upload');
    TestBed.inject(TranslocoService).setActiveLang('es');
    await fixture.whenStable();
    expect(text()).toContain('Importado de Insomnia. Peticiones: 12, carpetas: 3, entornos: 2.');
    expect(text()).toContain('Ficheros que hay que volver a elegir: Upload');
  });

  it('says when everything came as it was', async () => {
    const fixture = await show({
      source: 'Bruno',
      requests: 1,
      folders: 0,
      environments: 0,
      notes: [],
    });
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Everything came as it was.',
    );
  });
});
