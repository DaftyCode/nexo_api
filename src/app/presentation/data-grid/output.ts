import { CopyFormat, SqlStyle, copyAs } from '../../domain/db/grid/copy';
import { GridSelection, selectedRange } from '../../domain/db/grid/selection';
import { ResultColumn } from '../../domain/db/results';
import { GridLayout } from './layout';

/** What a grid's copies and downloads are made of. */
export interface OutputSource {
  layout: GridLayout;
  selection(): GridSelection;
  columns(): readonly ResultColumn[];
  rows(): readonly unknown[][];
  sql(): SqlStyle | undefined;
  label(): string;
  save(name: string, text: string, type: string): void;
}

/** The selection copied, and every row shown saved to a file, in the formats a grid offers. */
export class GridOutput {
  constructor(private readonly source: OutputSource) {}

  /** The cells of the selection, in the order shown. */
  selectedCells() {
    const { layout, rows, columns } = this.source;
    const range = selectedRange(
      this.source.selection(),
      layout.shown().length,
      layout.order().length,
    );
    const chosen = layout.order().slice(range.left, range.right + 1);
    const values = layout
      .shown()
      .slice(range.top, range.bottom + 1)
      .map((index) => chosen.map((column) => rows()[index][column]));
    return { columns: chosen.map((column) => columns()[column]), rows: values };
  }

  copy(event: Event | undefined, format: CopyFormat) {
    event?.preventDefault();
    const text = copyAs(this.selectedCells(), format, this.source.sql());
    void globalThis.navigator?.clipboard?.writeText(text);
  }

  /** Saves every row shown, in the order and with the columns shown, as CSV or JSON. */
  download(format: 'csv' | 'json') {
    const { layout, rows, columns } = this.source;
    const order = layout.order();
    const values = layout.shown().map((index) => order.map((column) => rows()[index][column]));
    const text = copyAs(
      { columns: order.map((column) => columns()[column]), rows: values },
      format,
      this.source.sql(),
    );
    const name = this.source.label().replace(/[^\w.-]+/g, '-') || 'rows';
    this.source.save(`${name}.${format}`, text, format === 'csv' ? 'text/csv' : 'application/json');
  }
}
