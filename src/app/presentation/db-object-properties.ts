import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import {
  PropertyCards,
  propertyCards,
  schemaOf,
  sectionCount,
} from '../domain/db/object-properties';
import { cellText } from '../domain/db/results';
import { CodeEditor } from './code-editor';
import { StudioIcon } from './studio-icon';
import { WorkspaceState, success } from './workspace-state';

/** What `db.describe` answers, as far as this view reads it. */
export interface DescribedObject {
  kind: string;
  name: string;
  properties: { name: string; value: unknown }[];
  sections: { id: string; title: string; columns: string[]; rows: unknown[][] }[];
}

/**
 * The «Properties» view of an object: its name and schema with its main figures, then cards
 * with its general information, its details, its storage and structure and an overview, its
 * definition when it has one, and whatever else its driver says of it.
 */
@Component({
  imports: [TranslocoPipe, NgTemplateOutlet, CodeEditor, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-object-properties',
  templateUrl: './db-object-properties.html',
  styleUrl: './db-object-properties.scss',
})
export class DbObjectProperties {
  readonly object = input.required<DescribedObject>();
  readonly path = input<readonly string[]>([]);
  /** The kind of object, as a message key («Table»…), and the icon of its kind. */
  readonly kind = input('');
  readonly icon = input('table');
  private readonly i18n = inject(TranslocoService);
  private readonly state = inject(WorkspaceState);

  private readonly numbers = computed(() => new Intl.NumberFormat(this.i18n.getActiveLang()));
  protected readonly schema = computed(() => schemaOf(this.path()));
  protected readonly cards = computed((): PropertyCards => {
    const lang = this.i18n.getActiveLang();
    const dates = new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'medium' });
    const cards = propertyCards(this.object(), this.path(), {
      date: (text) => {
        const date = new Date(text);
        return Number.isNaN(date.getTime()) ? text : dates.format(date);
      },
      number: (value) => this.numbers().format(value),
    });
    const kind = this.kind() ? this.i18n.translate(this.kind()) : '';
    return {
      ...cards,
      general: cards.general.map((row) =>
        row.name === 'Kind' && kind ? { ...row, value: kind } : row,
      ),
    };
  });
  private property(name: string) {
    const found = this.object().properties.find((property) => property.name === name);
    const text = found ? cellText(found.value) : '';
    return text && text !== 'NULL' ? text : undefined;
  }
  protected readonly rows = computed(() => {
    const rows = Number(this.property('Estimated rows'));
    return Number.isFinite(rows) && rows >= 0 ? this.numbers().format(rows) : undefined;
  });
  protected readonly counts = computed(() => {
    const object = this.object();
    return {
      columns: sectionCount(object, 'columns'),
      constraints: sectionCount(object, 'constraints'),
      indexes: sectionCount(object, 'indexes'),
    };
  });
  /** The figures at the top: kind, owner, rows, size and columns, those the driver gives. */
  protected readonly stats = computed(() => {
    const columns = this.counts().columns;
    const kind = this.kind() ? this.i18n.translate(this.kind()) : this.object().kind;
    return [
      { label: 'Kind', value: kind, icon: this.icon() },
      { label: 'Owner', value: this.property('Owner'), icon: 'role' },
      { label: 'Estimated rows', value: this.rows(), icon: 'dependency' },
      {
        label: 'Size',
        value: this.property('Table size') ?? this.property('Size'),
        icon: 'databases',
      },
      {
        label: 'Columns',
        value: columns === undefined ? undefined : this.numbers().format(columns),
        icon: 'bars',
      },
    ].filter((stat) => stat.value !== undefined);
  });

  protected copy(text: string) {
    void globalThis.navigator?.clipboard?.writeText(text);
    this.state.tell(success('Copied to the clipboard'));
  }
}
