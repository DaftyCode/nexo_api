/**
 * JSON files of documents: an array, JSON Lines or documents one after another, in Extended
 * JSON or in the syntax of the mongo shell (`ObjectId("…")`, `ISODate("…")`).
 */
import { shellToExtendedJson } from '../mongo-query';
import { relaxed } from '../bson/shell';
import type { JsonFlavour } from '../mongo-transfer';

/** A document read, or why the text at its position is not one. */
export type ReadDocument = { document: Record<string, unknown> } | { error: string };

/**
 * Reads the documents of JSON text given in chunks: each object at the top level, or as an
 * element of a top-level array. A chunk may end anywhere, even inside a string.
 */
export class JsonDocumentsReader {
  private text = '';
  private depth = 0;
  /** Depth of the documents: 1 inside a top-level array, 0 otherwise. */
  private base = 0;
  private string: '"' | "'" | '' = '';
  private escaped = false;
  /** Inside text that is not a document. */
  private junk = false;

  push(chunk: string): ReadDocument[] {
    const documents: ReadDocument[] = [];
    for (const character of chunk) {
      if (this.string) {
        this.text += character;
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === this.string) this.string = '';
        continue;
      }
      if (this.depth === this.base && !this.text) {
        // Between documents: the array's own brackets, commas and blanks.
        if (character === '[' && this.depth === 0 && this.base === 0) {
          this.base = 1;
          this.depth = 1;
          continue;
        }
        if (character === ']' && this.base === 1) {
          this.base = 0;
          this.depth = 0;
          continue;
        }
        if (character === ',' || /\s/.test(character)) continue;
        if (character !== '{') {
          // Text that is not a document, up to the next one, is one error.
          if (!this.junk) documents.push({ error: 'json' });
          this.junk = true;
          continue;
        }
        this.junk = false;
      }
      this.text += character;
      if (character === '"' || character === "'") this.string = character;
      else if (character === '{' || character === '[') this.depth++;
      else if (character === '}' || character === ']') {
        this.depth--;
        if (this.depth === this.base) documents.push(this.document());
      }
    }
    return documents;
  }
  /** What is left when the text ends: a document not closed is an error. */
  end(): ReadDocument[] {
    const left = this.text.trim();
    this.text = '';
    return left ? [{ error: 'json' }] : [];
  }
  private document(): ReadDocument {
    const text = this.text;
    this.text = '';
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value))
        return { document: value as Record<string, unknown> };
    } catch {
      // Not JSON: perhaps the syntax of the mongo shell.
    }
    try {
      const value = shellToExtendedJson(text);
      if (value && typeof value === 'object' && !Array.isArray(value))
        return { document: value as Record<string, unknown> };
    } catch {
      // Neither.
    }
    return { error: 'json' };
  }
}

/** A document as JSON text, canonical (every type kept) or relaxed. */
export function jsonDocument(document: unknown, flavour: JsonFlavour): string {
  return JSON.stringify(flavour === 'canonical' ? document : relaxed(document));
}
