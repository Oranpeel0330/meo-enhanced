const svgNamespace = 'http://www.w3.org/2000/svg';

function createLayer() {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('meo-md-table-selection-layer');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNamespace, 'path');
  svg.appendChild(path);
  return { svg, path };
}

export class TableTextSelectionPaint {
  private layer: ReturnType<typeof createLayer> | null = null;

  paint(host: HTMLElement, ranges: Iterable<AbstractRange>): void {
    const lineHeight = parseFloat(getComputedStyle(host).lineHeight);
    if (!(lineHeight > 0)) { this.clear(); return; }
    const fragments = Array.from(ranges).flatMap(range => range instanceof Range ? Array.from(range.getClientRects()) : [])
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => ({ rect, center: (rect.top + rect.bottom) / 2 }))
      .sort((first, second) => first.center - second.center);
    if (!fragments.length) { this.clear(); return; }

    const origin = host.getBoundingClientRect();
    const scale = host.ownerDocument.defaultView?.devicePixelRatio || 1;
    const snap = (value: number) => Math.round(value * scale) / scale;
    const bands: string[] = [];
    for (let start = 0; start < fragments.length;) {
      const first = fragments[start]!;
      let reference = first;
      let end = start + 1;
      for (; end < fragments.length && fragments[end]!.center - first.center < lineHeight / 2; end++) {
        const fragment = fragments[end]!;
        if (fragment.rect.height > reference.rect.height) reference = fragment;
      }
      const top = snap(reference.center - lineHeight / 2) - origin.top;
      const bottom = snap(reference.center + lineHeight / 2) - origin.top;
      for (; start < end; start++) {
        const { rect } = fragments[start]!;
        const left = snap(rect.left) - origin.left;
        const right = snap(rect.right) - origin.left;
        bands.push(`M${left},${top}H${right}V${bottom}H${left}Z`);
      }
    }
    const layer = this.layer ??= createLayer();
    const path = bands.join('');
    if (layer.path.getAttribute('d') !== path) layer.path.setAttribute('d', path);
    if (layer.svg.parentElement !== host) host.appendChild(layer.svg);
  }

  clear(): void { this.layer?.svg.remove(); }
}
