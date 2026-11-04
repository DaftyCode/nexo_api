import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { EnvironmentPanel } from './environment-panel';
import { RunnerPanel } from './runner-panel';
import { ProtocolPanel } from './protocol-panel';
import { DataPanel } from './data-panel';
import { IntegrationPanel } from './integration-panel';
import { CollectionSettingsPanel } from './collection-settings-panel';

@Component({
  imports: [
    EnvironmentPanel,
    RunnerPanel,
    ProtocolPanel,
    DataPanel,
    IntegrationPanel,
    CollectionSettingsPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-tools-panel',
  styleUrl: './tools-panel.scss',
  templateUrl: './tools-panel.html',
})
export class ToolsPanel {
  readonly section = input('settings');
}
