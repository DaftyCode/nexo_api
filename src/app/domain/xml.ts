/**
 * A small XML reader for files other tools write (MySQL Workbench's `connections.xml`):
 * elements with their attributes, text and children. Comments, declarations, doctypes and
 * processing instructions are skipped; CDATA is text; entities are the five of XML and
 * numeric ones. It never fetches anything a document names.
 */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The text directly inside, trimmed. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Replaces the entities of a text or an attribute value. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : +entity.slice(1);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of source.matchAll(/([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
    found[match[1]] = decodeXml(match[3] ?? match[4] ?? '');
  return found;
}

/** Reads a document into its root element; throws when it is not well formed. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '', attributes: {}, children: [], text: '' };
  const open: XmlElement[] = [root];
  const texts: string[][] = [[]];
  let index = 0;
  const skip = (end: string) => {
    const at = source.indexOf(end, index);
    if (at < 0) throw new Error('The XML is not complete');
    const inside = source.slice(index, at);
    index = at + end.length;
    return inside;
  };
  while (index < source.length) {
    const tag = source.indexOf('<', index);
    if (tag < 0) {
      texts[texts.length - 1].push(decodeXml(source.slice(index)));
      break;
    }
    texts[texts.length - 1].push(decodeXml(source.slice(index, tag)));
    index = tag;
    if (source.startsWith('<!--', index)) {
      index += 4;
      skip('-->');
    } else if (source.startsWith('<![CDATA[', index)) {
      index += 9;
      texts[texts.length - 1].push(skip(']]>'));
    } else if (source.startsWith('<?', index) || source.startsWith('<!', index)) {
      index += 2;
      skip('>');
    } else if (source.startsWith('</', index)) {
      index += 2;
      const name = skip('>').trim();
      const element = open.pop();
      if (!element || element === root || element.name !== name)
        throw new Error('The XML is not well formed');
      element.text = texts.pop()!.join('').trim();
    } else {
      index += 1;
      let inside = skip('>');
      const empty = inside.endsWith('/');
      if (empty) inside = inside.slice(0, -1);
      const name = /^[^\s/>]+/.exec(inside)?.[0];
      if (!name) throw new Error('The XML is not well formed');
      const element: XmlElement = {
        name,
        attributes: attributes(inside.slice(name.length)),
        children: [],
        text: '',
      };
      open[open.length - 1].children.push(element);
      if (!empty) {
        open.push(element);
        texts.push([]);
      }
    }
  }
  if (open.length !== 1 || root.children.length !== 1) throw new Error('The XML is not complete');
  return root.children[0];
}

/** Every element under `element` (itself included) named `name`, in document order. */
export function xmlElements(element: XmlElement, name: string): XmlElement[] {
  const found = element.name === name ? [element] : [];
  for (const child of element.children) found.push(...xmlElements(child, name));
  return found;
}
