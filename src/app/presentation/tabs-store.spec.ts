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
});
