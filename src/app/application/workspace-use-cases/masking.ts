import { WorkspaceDocument } from '../../domain/models';
import {
  MaskRule,
  MaskingForm,
  MaskingSet,
  maskingRules,
  maskingValue,
  readMaskingSet,
} from '../../domain/masking';
import { ApiPort } from '../ports';

/** Documents or rows the backend masks in one call: a page of an export. */
export const MASK_BATCH = 1000;

/**
 * Masking sets (B-06): workspace documents with rules; the backend masks with them and
 * keeps the key of its hashes and synthetic values, so the same value always gives the
 * same token in a workspace and nobody can go back to the original.
 */
export class MaskingCases {
  constructor(private readonly api: ApiPort) {}

  /** The sets among a workspace's documents, by name. */
  sets(documents: readonly WorkspaceDocument[]): MaskingSet[] {
    return documents
      .map(readMaskingSet)
      .filter((set): set is MaskingSet => !!set)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  save(
    workspace: string,
    id: string,
    form: MaskingForm,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'masking',
      name: form.name.trim(),
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: maskingValue(form),
    });
  }

  remove(document: WorkspaceDocument) {
    return this.api.remove(document);
  }

  /**
   * Rules not saved yet tried on a JSON sample: an array masks each item, anything else
   * as one document.
   */
  async tryRules(workspace: string, rules: readonly MaskRule[], sample: string): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sample);
    } catch {
      throw new Error('The example must be valid JSON');
    }
    const many = Array.isArray(parsed);
    const { documents } = await this.api.execute<{ documents: unknown[] }>('mask.apply', {
      workspace,
      rules: maskingRules(rules),
      documents: many ? (parsed as unknown[]) : [parsed],
    });
    return many ? documents : documents[0];
  }

  /** Documents masked with the saved set `set`, in batches. */
  async documents(workspace: string, set: string, documents: readonly unknown[]) {
    const masked: unknown[] = [];
    for (let at = 0; at < documents.length; at += MASK_BATCH) {
      const page = await this.api.execute<{ documents: unknown[] }>('mask.apply', {
        workspace,
        set,
        documents: documents.slice(at, at + MASK_BATCH),
      });
      masked.push(...page.documents);
    }
    return masked;
  }

  /**
   * Rows of a table masked with the saved set `set`: each column is a field. The columns
   * a rule removes are left out of the columns and of every row.
   */
  async rows(
    workspace: string,
    set: string,
    columns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<{ columns: string[]; rows: unknown[][]; kept: number[] }> {
    let kept = columns.map((_, at) => at);
    const masked: unknown[][] = [];
    for (let at = 0; at < Math.max(rows.length, 1); at += MASK_BATCH) {
      const page = await this.api.execute<{ kept: number[]; rows: unknown[][] }>('mask.apply', {
        workspace,
        set,
        columns,
        rows: rows.slice(at, at + MASK_BATCH),
      });
      kept = page.kept;
      masked.push(...page.rows);
    }
    return { columns: kept.map((at) => columns[at]), rows: masked, kept };
  }
}
