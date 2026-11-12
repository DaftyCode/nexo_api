import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  WritableSignal,
  computed,
  input,
  output,
} from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { KeyValue } from '../domain/models';
import { KeyValueEditor } from './key-value-editor';
import { ProtocolSettings } from './protocol-settings';

/** A Kafka connection: TLS and SASL, the record to produce and where to read from. */
@Component({
  imports: [TranslocoPipe, FormField, KeyValueEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-kafka-settings',
  styles: ':host { display: contents; }',
  templateUrl: './kafka-settings.html',
})
export class KafkaSettings {
  /** The form of the protocol panel. */
  readonly fields = input.required<FieldTree<ProtocolSettings>>();
  /** The settings, to read. */
  protected readonly settings = computed(() => this.fields()().value());
  /** The message headers of the panel, which this editor changes in place. */
  readonly headers = input.required<WritableSignal<KeyValue[]>>();
  /** Whether the connection is open, which the actions need. */
  readonly connected = input(false);
  /** `subscribe`, `unsubscribe` or `topics`. */
  readonly action = output<string>();
  /** How a Kafka password refers to a vault secret. */
  protected readonly vaultExample = '{{vault:name}}';
}
