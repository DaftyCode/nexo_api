/** How the members of the script API are described for the editor. */
export interface ScriptMember {
  name: string;
  kind: 'property' | 'method' | 'object';
  /** How it is called or what it holds, shown next to the name. */
  signature: string;
  doc: string;
  /** Members of the object, for `name.`. */
  members?: ScriptMember[];
  /** Members of what a call returns, for `name(…).`. */
  returns?: ScriptMember[];
}

export const method = (
  name: string,
  signature: string,
  doc: string,
  returns?: ScriptMember[],
): ScriptMember => ({ name, kind: 'method', signature, doc, ...(returns ? { returns } : {}) });
export const property = (name: string, signature: string, doc: string): ScriptMember => ({
  name,
  kind: 'property',
  signature,
  doc,
});
export const object = (name: string, doc: string, members: ScriptMember[]): ScriptMember => ({
  name,
  kind: 'object',
  signature: '',
  doc,
  members,
});
