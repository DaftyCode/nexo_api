import { describe, expect, it } from 'vitest';
import { decodeXml, parseXml, xmlElements } from './xml';

describe('the XML reader', () => {
  it('reads elements, attributes, text and entities, skipping what is not data', () => {
    const root = parseXml(`<?xml version="1.0"?>
      <!DOCTYPE data>
      <!-- a comment with <tags> -->
      <data kind='list' note="a &quot;b&quot; &amp; c">
        <item id="1">One &lt;1&gt; &#65;&#x42;</item>
        <item id="2"><![CDATA[<raw> & text]]></item>
        <empty flag="yes"/>
        <?processing instruction?>
      </data>`);
    expect(root.name).toBe('data');
    expect(root.attributes).toEqual({ kind: 'list', note: 'a "b" & c' });
    const items = xmlElements(root, 'item');
    expect(items.map((item) => [item.attributes['id'], item.text])).toEqual([
      ['1', 'One <1> AB'],
      ['2', '<raw> & text'],
    ]);
    expect(xmlElements(root, 'empty')[0]).toEqual({
      name: 'empty',
      attributes: { flag: 'yes' },
      children: [],
      text: '',
    });
    expect(decodeXml('&unknown; &#0; &apos;')).toBe("&unknown; &#0; '");
  });

  it('says when a document is not well formed or not complete', () => {
    for (const broken of ['<a><b></a>', '<a>', '<a></a><b></b>', '</a>', '<a><!-- x', '<>', 'text'])
      expect(() => parseXml(broken), broken).toThrow();
  });
});
