import { ConnectionForm, MongoConnectionValue, emptyConnectionForm } from '../../domain/mongo';
import { Route, emptyRoute, storedRoute } from '../../domain/route';

/** What the form of a MongoDB connection edits. */
export interface PanelModel extends ConnectionForm {
  name: string;
  folder: string;
  color: string;
  readOnly: boolean;
  /** Exposed to MCP agents, read-only, and the fields they never see. */
  mcp: boolean;
  mcpHidden: string;
  /** Typed here; blank keeps what the vault has. */
  password: string;
  caPem: string;
  certPem: string;
  /** Typed here; blank keeps what the vault has. */
  keyPem: string;
  /** A URI pasted to fill the form. */
  paste: string;
  route: Route;
}

export function emptyModel(): PanelModel {
  return {
    ...emptyConnectionForm(),
    name: 'Local MongoDB',
    folder: '',
    color: '',
    readOnly: false,
    mcp: false,
    mcpHidden: '',
    password: '',
    caPem: '',
    certPem: '',
    keyPem: '',
    paste: '',
    route: emptyRoute(),
  };
}

/**
 * The connection as it is saved: the form's URI and fields, with the vault references it
 * already had (`stored`) where nothing new was typed.
 */
export function storedValue(
  model: PanelModel,
  stored: MongoConnectionValue,
  uri: string,
): MongoConnectionValue {
  const route = storedRoute(model.route);
  const hidden = model.mcpHidden
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    uri,
    ...(stored.password && model.auth !== 'none' ? { password: stored.password } : {}),
    ...(model.caPem.trim() ? { caPem: model.caPem.trim() } : {}),
    ...(model.certPem.trim() ? { certPem: model.certPem.trim() } : {}),
    ...(stored.keyPem && model.certPem.trim() ? { keyPem: stored.keyPem } : {}),
    ...(model.folder.trim() ? { folder: model.folder.trim() } : {}),
    ...(model.color ? { color: model.color } : {}),
    ...(model.readOnly ? { readOnly: true } : {}),
    ...(model.mcp ? { mcp: true } : {}),
    ...(model.mcp && hidden.length ? { mcpHidden: hidden } : {}),
    ...(route ? { nexoRoute: route } : {}),
  };
}

/** The secrets typed in the form, which go to the vault. */
export function typedSecrets(model: PanelModel) {
  return {
    ...(model.auth !== 'none' && model.password ? { password: model.password } : {}),
    ...(model.keyPem.trim() ? { keyPem: model.keyPem } : {}),
  };
}
