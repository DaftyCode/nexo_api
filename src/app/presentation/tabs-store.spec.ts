import { TabsStore } from './tabs-store';
import { newRequest } from '../domain/models';

describe('TabsStore', () => {
  function store() {
    let next = 0;
    return new TabsStore(() => `t${++next}`);
  }
  it('opens, edits and closes tabs, keeping a sensible active tab', () => {
    const tabs = store();
    const first = tabs.open();
    const second = tabs.open(newRequest('r'), 'doc', [0, 1]);
    expect(tabs.activeId()).toBe(second);
    tabs.edit({ ...tabs.active()!.request, url: 'http://x' });
    expect(tabs.active()?.dirty).toBe(true);
    expect(tabs.unsaved()).toBe(true);
    expect(tabs.find('doc', [0, 1])?.id).toBe(second);
    tabs.close(second);
    expect(tabs.activeId()).toBe(first);
    expect(tabs.unsaved()).toBe(false);
  });

  it('keeps the response of each tab and shows the active one', () => {
    const tabs = store();
    const response = (body: string) => ({
      status: 200,
      statusText: 'OK',
      body,
      headers: [],
      time: 1,
      size: 1,
      assertions: [],
      logs: [],
    });
    const first = tabs.open();
    tabs.setResponse(first, response('first'));
    const second = tabs.open();
    // A new tab has no response yet; the first keeps its own.
    expect(tabs.response()).toBeUndefined();
    tabs.setResponse(second, response('second'));
    expect(tabs.response()?.body).toBe('second');
    tabs.activeId.set(first);
    expect(tabs.response()?.body).toBe('first');
    tabs.activeId.set(second);
    expect(tabs.response()?.body).toBe('second');
    tabs.setResponse(second, undefined);
    expect(tabs.response()).toBeUndefined();
    // Closing a tab forgets its response; another workspace forgets them all.
    tabs.close(first);
    tabs.setResponse(second, response('again'));
    expect(tabs.response()?.body).toBe('again');
    tabs.clearResponses();
    expect(tabs.response()).toBeUndefined();
  });
});
