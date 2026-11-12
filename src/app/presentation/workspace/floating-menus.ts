/**
 * The actions menus of the sidebar, placed against the window so that they float over the
 * next panel: the sidebar clips its overflow, so a menu inside it would be cut off.
 */
export class FloatingMenus {
  constructor(private readonly host: HTMLElement) {}

  /** Closes the open menus but `except`. */
  close(except?: Element) {
    for (const menu of this.host.querySelectorAll('details.collection-menu[open]'))
      if (menu !== except) menu.removeAttribute('open');
  }
  /** Closes a menu after one of its buttons is used, or every menu after a click outside. */
  clicked(event: Event) {
    const target = event.target as HTMLElement;
    const menu = target.closest('details.collection-menu');
    if (!menu) this.close();
    else if (target.closest('button') && !target.closest('summary')) menu.removeAttribute('open');
  }
  /**
   * The sidebar scrolled: open menus follow their button, and close once it is scrolled out
   * of sight. Clicking a button near the edge scrolls it into view first, so closing on any
   * scroll would close the menu that click opened.
   */
  follow(sidebar: HTMLElement) {
    const visible = sidebar.getBoundingClientRect();
    for (const menu of sidebar.querySelectorAll<HTMLDetailsElement>(
      'details.collection-menu[open]',
    )) {
      const anchor = menu.querySelector('summary')?.getBoundingClientRect();
      if (anchor && anchor.bottom > visible.top && anchor.top < visible.bottom) this.place(menu);
      else menu.removeAttribute('open');
    }
  }
  /** A menu opened or closed. */
  toggled(event: Event) {
    const menu = event.target as HTMLDetailsElement;
    if (!menu.open) {
      delete menu.dataset['placed'];
      return;
    }
    this.close(menu);
    this.place(menu);
  }
  /** Places an opened menu below its button and towards the next panel, inside the window. */
  private place(menu: HTMLDetailsElement) {
    const summary = menu.querySelector('summary');
    const panel = menu.querySelector<HTMLElement>(':scope > div');
    if (!summary || !panel) return;
    const margin = 8;
    const anchor = summary.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const below = anchor.bottom + 4;
    const top =
      below + height + margin <= window.innerHeight
        ? below
        : Math.max(margin, anchor.top - height - 4);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    menu.dataset['placed'] = '';
  }
}
