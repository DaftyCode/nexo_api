import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component } from '@angular/core';

/* The sections of the documentation, in the order of its index. Only text: no logic. */

@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-docs-start',
  templateUrl: './start.html',
})
export class DocsStart {}

@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-docs-testing',
  templateUrl: './testing.html',
})
export class DocsTesting {}

@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-docs-tools',
  templateUrl: './tools.html',
})
export class DocsTools {}

@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-docs-data',
  templateUrl: './data.html',
})
export class DocsData {}

@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-docs-workspace',
  templateUrl: './workspace.html',
})
export class DocsWorkspace {}
