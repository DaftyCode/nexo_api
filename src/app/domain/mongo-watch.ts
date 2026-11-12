/**
 * MongoDB change streams as the realtime panel opens them: what is watched, the pipeline that
 * filters the changes, and the documents each change carries.
 */

import { QuerySyntaxError } from './mongo-query/reader';
import { shellToExtendedJson } from './mongo-query';

/** The settings of a change stream, as the panel types them. */
export interface WatchSettings {
  database: string;
  collection: string;
  /** An array of stages in the shell syntax or Extended JSON; empty for every change. */
  pipeline: string;
  fullDocument: string;
  fullDocumentBeforeChange: string;
  resumeAfter: string;
}

export type FullDocument = 'default' | 'updateLookup' | 'whenAvailable' | 'required';
export type BeforeChange = 'off' | 'whenAvailable' | 'required';
const FULL_DOCUMENT: readonly string[] = ['updateLookup', 'whenAvailable', 'required'];
const BEFORE_CHANGE: readonly string[] = ['whenAvailable', 'required'];

/** What `mongo.watch` receives besides the connection. */
export interface WatchOptions {
  database?: string;
  collection?: string;
  pipeline: Record<string, unknown>[];
  fullDocument?: FullDocument;
  fullDocumentBeforeChange?: BeforeChange;
  resumeAfter?: string;
}

/** A pipeline that cannot be used, with the message key and its values. */
export class WatchPipelineError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(key);
  }
}

/** The options of a change stream, with the variables of the environment replaced. */
export function watchOptions(
  settings: WatchSettings,
  resolve: (text: string) => string = (t) => t,
): WatchOptions {
  const text = resolve(settings.pipeline).trim();
  let pipeline: unknown = [];
  if (text) {
    try {
      pipeline = shellToExtendedJson(text);
    } catch (error) {
      if (!(error instanceof QuerySyntaxError)) throw error;
      throw new WatchPipelineError('mongo.watch.syntax', {
        v0: error.reason,
        v1: error.line,
        v2: error.column,
      });
    }
  }
  if (
    !Array.isArray(pipeline) ||
    pipeline.some((stage) => !stage || typeof stage !== 'object' || Array.isArray(stage))
  )
    throw new WatchPipelineError('mongo.watch.pipeline');
  const database = resolve(settings.database).trim();
  const collection = resolve(settings.collection).trim();
  if (collection && !database) throw new WatchPipelineError('mongo.watch.database');
  const resumeAfter = resolve(settings.resumeAfter).trim();
  return {
    ...(database ? { database } : {}),
    ...(collection ? { collection } : {}),
    pipeline: pipeline as Record<string, unknown>[],
    ...(FULL_DOCUMENT.includes(settings.fullDocument)
      ? { fullDocument: settings.fullDocument as FullDocument }
      : {}),
    ...(BEFORE_CHANGE.includes(settings.fullDocumentBeforeChange)
      ? { fullDocumentBeforeChange: settings.fullDocumentBeforeChange as BeforeChange }
      : {}),
    ...(resumeAfter ? { resumeAfter } : {}),
  };
}

/** What a change stream watches, in one line: `shop.orders`, `shop` or the deployment. */
export function watchLabel(settings: Pick<WatchSettings, 'database' | 'collection'>): string {
  const database = settings.database.trim();
  const collection = settings.collection.trim();
  if (!database) return 'deployment';
  return collection ? `${database}.${collection}` : database;
}
