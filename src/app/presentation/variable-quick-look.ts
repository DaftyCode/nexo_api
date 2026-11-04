import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { WorkspaceState } from './workspace-state';
import { VariableRow, isSensitive, toVariableRows } from '../domain/variables';
import { asCollection } from '../domain/models';

interface ScopeView {
  id: 'environment' | 'collection' | 'globals';
  title: string;
  name: string;
  rows: VariableRow[];
}

/** Workspace bar control: active environment selector plus a quick look at every scope. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-variable-quick-look',
  styleUrl: './variable-quick-look.scss',
  templateUrl: './variable-quick-look.html',
})
export class VariableQuickLook {
  protected readonly state = inject(WorkspaceState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly open = signal(false);
  protected readonly revealed = signal(false);
  protected readonly scopes = computed<ScopeView[]>(() => {
    const collection = this.state.activeCollection();
    let collectionRows: VariableRow[];
    try {
      collectionRows = collection ? toVariableRows(asCollection(collection.value)['variable']) : [];
    } catch {
      collectionRows = [];
    }
    return [
      {
        id: 'environment',
        title: 'Environment',
        name: this.state.environmentDocument()?.name ?? '',
        rows: this.state.environmentRows().filter((row) => row.key),
      },
      {
        id: 'collection',
        title: 'Collection',
        name: collection?.name ?? '',
        rows: collectionRows.filter((row) => row.key),
      },
      {
        id: 'globals',
        title: 'Globals',
        name: '',
        rows: this.state.globalRows().filter((row) => row.key),
      },
    ];
  });
  protected display(row: VariableRow) {
    return isSensitive(row) && !this.revealed() ? '••••••••' : row.value;
  }
  protected select(event: Event) {
    this.state.selectEnvironment((event.target as HTMLSelectElement).value);
  }
  protected edit(scope: ScopeView['id']) {
    this.open.set(false);
    const collection = this.state.activeCollection();
    if (scope === 'collection' && collection) this.state.openCollectionSettings(collection.id);
    else this.state.section.set('environments');
  }
  @HostListener('document:click', ['$event']) protected outside(event: MouseEvent) {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node))
      this.open.set(false);
  }
  @HostListener('document:keydown.escape') protected escape() {
    this.open.set(false);
  }
}
