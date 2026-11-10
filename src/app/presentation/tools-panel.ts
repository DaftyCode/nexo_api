import { Component, ChangeDetectionStrategy, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { WorkspaceState } from './workspace-state';
import { EnvironmentPanel } from './environment-panel';
import { RunnerPanel } from './runner-panel';
import { ProtocolPanel } from './protocol-panel';
import { DataPanel } from './data-panel';
import { IntegrationPanel } from './integration-panel';
import { CollectionSettingsPanel } from './collection-settings-panel';
import { MongoPanel } from './mongo-panel';

/** Names of the sections "Back" can return to. */
const sectionLabels: Record<string, string> = {
  collections: 'Collections',
  environments: 'Environments',
  history: 'History',
  runner: 'Runner',
  realtime: 'Protocols',
  mocks: 'Mocks',
  datasets: 'Datasets',
  mongo: 'MongoDB',
  git: 'Git',
  mcp: 'MCP',
  settings: 'Settings',
  code: 'Code',
  'collection-settings': 'Collection settings',
};

@Component({
  imports: [
    TranslocoPipe,
    EnvironmentPanel,
    RunnerPanel,
    ProtocolPanel,
    DataPanel,
    IntegrationPanel,
    CollectionSettingsPanel,
    MongoPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-tools-panel',
  styleUrl: './tools-panel.scss',
  templateUrl: './tools-panel.html',
})
export class ToolsPanel {
  protected readonly state = inject(WorkspaceState);
  readonly section = input('settings');
  protected sectionLabel(section: string) {
    return sectionLabels[section] ?? 'Collections';
  }
}
