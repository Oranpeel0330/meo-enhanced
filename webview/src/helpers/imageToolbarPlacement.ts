/** Places fixed reading controls without changing the image or document layout. */
export function placeImageToolbar(
  image: HTMLImageElement,
  toolbar: HTMLElement,
  scroller: HTMLElement | null = null,
  topInset = 5
): boolean {
  const root = image.ownerDocument.documentElement;
  const scrollBounds = scroller?.getBoundingClientRect();
  const gutter = scroller?.querySelector(':scope > .cm-gutters');
  const left = Math.max(0, scrollBounds?.left ?? 0, gutter?.getBoundingClientRect().right ?? 0);
  const top = Math.max(0, scrollBounds?.top ?? 0);
  const right = Math.min(root.clientWidth, scrollBounds && scroller ? scrollBounds.left + scroller.clientWidth : root.clientWidth);
  const bottom = Math.min(root.clientHeight, scrollBounds && scroller ? scrollBounds.top + scroller.clientHeight : root.clientHeight);
  const picture = image.getBoundingClientRect();
  const imageLeft = Math.max(left, picture.left);
  const imageRight = Math.min(right, picture.right);
  const imageTop = Math.max(top, picture.top);
  const imageBottom = Math.min(bottom, picture.bottom);
  const imageWidth = imageRight - imageLeft;
  const imageHeight = imageBottom - imageTop;
  if (imageWidth <= 0 || imageHeight <= 0) return false;

  toolbar.hidden = false;
  toolbar.style.maxWidth = `${right - left}px`;
  const { width, height } = toolbar.getBoundingClientRect();
  const alignedRight = Math.max(imageLeft, imageRight - width - 5);
  const center = (imageLeft + imageRight - width) / 2;
  const x = Math.max(left, Math.min(right - width, width <= imageWidth ? alignedRight : center));
  let y = Math.min(imageTop + topInset, imageBottom - height);
  if (width > imageWidth || height > imageHeight) {
    // Meet the image edge so the pointer can cross directly into the toolbar.
    if (imageTop - height >= top) y = imageTop - height;
    else if (imageBottom + height <= bottom) y = imageBottom;
    else y = Math.max(top, Math.min(bottom - height, imageTop));
  }
  toolbar.style.left = `${x}px`;
  toolbar.style.top = `${y}px`;
  return true;
}
