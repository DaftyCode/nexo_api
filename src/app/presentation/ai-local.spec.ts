import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiFailure } from '../application/ports';
import { LocalAiStatus } from '../domain/ai';
import { clickButton, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { AiLocal } from './ai-local';
import { WorkspaceState } from './workspace-state';

const idle: LocalAiStatus = {
  backend: 'vulkan',
  engine: false,
  engineSize: 38_935_891,
  modelSize: 2_740_937_888,
  devices: [],
  ramFreeMib: 8192,
  running: false,
  installing: false,
  received: 0,
  total: 0,
};
const ready: LocalAiStatus = {
  ...idle,
  engine: true,
  model: 'qwen3.5-4b',
  modelName: 'Qwen3.5-4B',
  devices: [
    { id: 'Vulkan0', name: 'Intel Iris Xe', totalMib: 20325, freeMib: 20325 },
    { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMib: 5996, freeMib: 5228 },
  ],
  device: 'Vulkan1',
  running: true,
  gpuLayers: '33/33',
  context: 16384,
};

describe('AiLocal', () => {
  let fixture: ComponentFixture<AiLocal>;
  let api: TestApi;
  let state: WorkspaceState;
  const changes: boolean[] = [];
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) {
      await new Promise((wait) => setTimeout(wait, 20));
      await fixture.whenStable();
    }
  };
  const create = async (status: LocalAiStatus) => {
    api.responses['ai.local.status'] = status;
    fixture = TestBed.createComponent(AiLocal);
    fixture.componentInstance.changed.subscribe((value) => changes.push(value));
    await until(() => !!text() && !text().includes('Measuring'));
  };

  beforeEach(async () => {
    changes.length = 0;
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [AiLocal],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
  });

  it('says the sizes before downloading, follows the download and shows what fit chose', async () => {
    await create(idle);
    expect(text()).toContain('Downloads llama.cpp for Vulkan (39 MB)');
    expect(text()).toContain('Qwen3.5-9B (5.7 GB) or Qwen3.5-4B (2.7 GB)');
    const statuses = [{ ...idle, installing: true, received: 1_000_000, total: 38_935_891 }, ready];
    api.responses['ai.local.install'] = { ...idle, installing: true, total: 38_935_891 };
    api.responses['ai.local.status'] = () => statuses.shift() ?? ready;
    await clickButton(fixture, 'Download the local model');
    await until(() => text().includes('Downloading the local model'));
    expect(text()).toContain('of 39 MB');
    await until(() => text().includes('Qwen3.5-4B'));
    expect(text()).toContain('NVIDIA GeForce RTX 3060 Laptop GPU');
    expect(text()).toContain('5228 of 5996 MiB free');
    expect(text()).toContain('33/33');
    expect(text()).toContain('16384');
    expect(changes).toEqual([true]);
  });

  it('uses a GGUF of one own, deletes the model and says why something failed', async () => {
    await create(idle);
    api.responses['ai.local.file'] = ready;
    root().querySelector('details')!.open = true;
    await fill(fixture, 'Path of the GGUF file', 'C:/models/mine.gguf');
    await clickButton(fixture, 'Use this file');
    await until(() => text().includes('Delete the local model'));
    expect(api.calls.find((call) => call.operation === 'ai.local.file')?.payload).toEqual({
      path: 'C:/models/mine.gguf',
    });
    state.confirm = () => false;
    await clickButton(fixture, 'Delete the local model');
    expect(api.calls.some((call) => call.operation === 'ai.local.remove')).toBe(false);
    state.confirm = () => true;
    api.responses['ai.local.remove'] = idle;
    await clickButton(fixture, 'Delete the local model');
    await until(() => text().includes('Download the local model'));
    expect(state.toast()).toMatchObject({ title: 'Local model deleted' });
    expect(changes).toEqual([true, false]);

    api.responses['ai.local.install'] = () => {
      throw new ApiFailure('No room on the disk', 'validation', 400);
    };
    await clickButton(fixture, 'Download the local model');
    await until(() => text().includes('No room on the disk'));
    api.responses['ai.local.status'] = { ...idle, error: 'The download does not match' };
    await clickButton(fixture, 'Download the local model');
    api.responses['ai.local.install'] = { ...idle, error: 'The download does not match' };
    await clickButton(fixture, 'Download the local model');
    await until(() => text().includes('The download does not match'));
    expect(text()).toContain('The download does not match');
  });
});
