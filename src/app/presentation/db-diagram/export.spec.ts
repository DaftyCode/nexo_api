import { afterEach, describe, expect, it, vi } from 'vitest';
import { pngOf, svgImage, themePalette } from './export';

/** An `Image` that loads, or fails to, as soon as it is given its address. */
function images(loads: boolean) {
  vi.stubGlobal(
    'Image',
    class {
      onload?: () => void;
      onerror?: () => void;
      set src(_: string) {
        queueMicrotask(() => (loads ? this.onload?.() : this.onerror?.()));
      }
    },
  );
}

describe('a diagram exported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is an image address and takes the palette of the element it is drawn in', () => {
    expect(svgImage('<svg a="1"/>')).toBe(
      'data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%221%22%2F%3E',
    );
    const element = document.createElement('div');
    element.style.setProperty('--nexo-color-surface', 'ivory');
    document.body.append(element);
    expect(themePalette(element).surface).toBe('ivory');
    element.remove();
  });

  it('draws a PNG smaller when it is huge, and says when it cannot be drawn', async () => {
    images(true);
    const scale = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale,
      drawImage: vi.fn(),
    } as never);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((done) => done(new Blob(['png'])));
    expect(await pngOf('<svg/>', 100_000, 100_000)).toBeInstanceOf(Blob);
    expect(scale).toHaveBeenCalledWith(0.25, 0.25);
    toBlob.mockImplementation((done) => done(null));
    await expect(pngOf('<svg/>', 10, 10)).rejects.toThrow('db.diagram.png');

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(pngOf('<svg/>', 10, 10)).rejects.toThrow('db.diagram.png');
    images(false);
    await expect(pngOf('<svg/>', 10, 10)).rejects.toThrow('db.diagram.png');
  });
});
