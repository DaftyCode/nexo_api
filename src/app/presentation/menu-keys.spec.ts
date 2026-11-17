import { describe, expect, it } from 'vitest';
import { menuKeys } from './menu-keys';

describe('the keys of a menu', () => {
  function menu() {
    const element = document.createElement('div');
    element.innerHTML =
      '<button>a</button><button disabled>b</button><button>c</button><button>d</button>';
    document.body.replaceChildren(element);
    return element;
  }
  const press = (element: HTMLElement, key: string, close: () => void = () => undefined) => {
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    menuKeys(event, element, close);
    return event;
  };
  const focused = () => document.activeElement?.textContent;

  it('moves between the enabled entries, around the ends, and closes with Escape or Tab', () => {
    const element = menu();
    press(element, 'ArrowDown');
    expect(focused()).toBe('a');
    press(element, 'ArrowDown');
    expect(focused()).toBe('c');
    press(element, 'End');
    expect(focused()).toBe('d');
    press(element, 'ArrowDown');
    expect(focused()).toBe('a');
    press(element, 'ArrowUp');
    expect(focused()).toBe('d');
    press(element, 'Home');
    expect(focused()).toBe('a');
    let closed = 0;
    expect(press(element, 'Escape', () => closed++).defaultPrevented).toBe(true);
    press(element, 'Tab', () => closed++);
    expect(closed).toBe(2);
    expect(press(element, 'x').defaultPrevented).toBe(false);
  });
});
