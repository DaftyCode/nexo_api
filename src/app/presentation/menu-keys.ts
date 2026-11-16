/** The keys of a menu: arrows, Home and End move between its entries; Escape and Tab close it. */
export function menuKeys(event: KeyboardEvent, menu: HTMLElement, close: () => void) {
  const items = [...menu.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const move = (to: number) => {
    event.preventDefault();
    items[(to + items.length) % items.length]?.focus();
  };
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    close();
  } else if (event.key === 'ArrowDown') move(index + 1);
  else if (event.key === 'ArrowUp') move(index - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(items.length - 1);
}
