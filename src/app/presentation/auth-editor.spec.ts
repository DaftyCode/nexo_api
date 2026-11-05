import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readAuth, writeAuth } from '../domain/auth';
import { testProviders } from '../testing/providers';
import { AuthEditor } from './auth-editor';

describe('AuthEditor', () => {
  let fixture: ComponentFixture<AuthEditor>;
  const input = (label: string) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('label')]
      .find((element) => element.textContent?.trim().startsWith(label))
      ?.querySelector('input') as HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [AuthEditor],
    }).compileComponents();
    fixture = TestBed.createComponent(AuthEditor);
  });

  it('shows Bruno key names and saves them under the Postman names', async () => {
    fixture.componentRef.setInput(
      'auth',
      readAuth({
        type: 'awsv4',
        awsv4: [
          { key: 'accessKeyId', value: 'AKID' },
          { key: 'secretAccessKey', value: 'secret' },
        ],
      }),
    );
    await fixture.whenStable();
    expect(input('Access Key').value).toBe('AKID');
    expect(input('Secret Key').value).toBe('secret');

    input('Access Key').value = 'AKID2';
    input('Access Key').dispatchEvent(new Event('input'));
    const saved = writeAuth(fixture.componentInstance.auth()) as {
      awsv4: { key: string; value: unknown }[];
    };
    expect(saved.awsv4).toContainEqual({ key: 'accessKey', value: 'AKID2', type: 'string' });
    expect(saved.awsv4.map((row) => row.key)).not.toContain('accessKeyId');
    expect(saved.awsv4.map((row) => row.key)).toContain('secretAccessKey');
  });

  it("keeps Insomnia's empty Bearer prefix", async () => {
    fixture.componentRef.setInput(
      'auth',
      readAuth({
        type: 'bearer',
        bearer: [
          { key: 'token', value: 't' },
          { key: 'prefix', value: '' },
        ],
      }),
    );
    await fixture.whenStable();
    expect(input('Prefix').value).toBe('');
  });

  it('shows Insomnia ASAP names and saves them under the Postman names', async () => {
    fixture.componentRef.setInput(
      'auth',
      readAuth({
        type: 'asap',
        asap: [
          { key: 'issuer', value: 'insomnia-issuer' },
          { key: 'keyId', value: 'key-1' },
        ],
      }),
    );
    await fixture.whenStable();
    expect(input('Issuer').value).toBe('insomnia-issuer');
    expect(input('Key ID').value).toBe('key-1');
    input('Issuer').value = 'nexo';
    input('Issuer').dispatchEvent(new Event('input'));
    const saved = writeAuth(fixture.componentInstance.auth()) as {
      asap: { key: string; value: unknown }[];
    };
    expect(saved.asap).toContainEqual({ key: 'iss', value: 'nexo', type: 'string' });
    expect(saved.asap.map((row) => row.key)).not.toContain('issuer');
  });
});
