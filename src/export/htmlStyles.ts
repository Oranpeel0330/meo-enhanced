import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, DomUtils } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { sanitizeHtmlStylesheet } from '../shared/htmlStyle';
import { isSafeHtmlStyleUrl, resolveHtmlStyleResources, htmlStyleHasResources, type HtmlStyleResources } from '../shared/htmlStyleResources';
import { rewriteExportImageSrc, type RewriteExportImageSrcOptions } from './assetPaths';

/** Node/VS Code share CSS IO with the standalone export resource pipeline. */
export function createHtmlStyleResources(options: RewriteExportImageSrcOptions, signal?: AbortSignal): HtmlStyleResources {
  return {
    signal,
    resolve(url, base) {
      if (!isSafeHtmlStyleUrl(url)) return '';
      return new URL(url, base ?? pathToFileURL(options.markdownFilePath).href).href;
    },
    async read(url) {
      if (!isSafeHtmlStyleUrl(url)) throw new Error('Unsupported stylesheet URL');
      if (url.startsWith('file:')) return { css: sanitizeHtmlStylesheet(await fs.readFile(fileURLToPath(url), 'utf8')), url };
      let current = url;
      const redirects = new Set<string>();
      for (;;) {
        if (!isSafeHtmlStyleUrl(current) || redirects.has(current) || redirects.size >= 10) throw new Error('Unsupported stylesheet redirect');
        redirects.add(current);
        const response = await fetch(current, { signal: signal ?? AbortSignal.timeout(10_000), redirect: 'manual' });
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new Error('Stylesheet redirect omitted its destination');
          current = new URL(location,current).href;
          continue;
        }
        if (!response.ok) throw new Error('Stylesheet could not be loaded');
        return { css: sanitizeHtmlStylesheet(await response.text()), url: response.url || current };
      }
    },
    async asset(url) {
      if (!isSafeHtmlStyleUrl(url)) return '';
      return rewriteExportImageSrc(url, options);
    }
  };
}

/** Resource resolution happens once per rendered document, after the shared
 * HTML policy. Content-only Preview uses its mounted resource lifecycle. */
export async function resolveExportHtmlStyles(html: string, options: RewriteExportImageSrcOptions): Promise<string> {
  if (!htmlStyleHasResources(html)) return html;
  const document = parseDocument(html);
  const resources = createHtmlStyleResources(options);
  const visit = async (nodes: readonly ChildNode[]): Promise<void> => {
    for (const node of nodes) {
      if (!('attribs' in node)) continue;
      if (node.name === 'style') {
        const css = node.children.map(child => child.type === 'text' ? child.data : '').join('');
        const resolved = await resolveHtmlStyleResources(css, resources);
        node.children = parseDocument(`<style>${resolved.replace(/<\/style/gi, '<\\/style')}</style>`).children.flatMap(child => 'children' in child ? child.children : []);
      } else {
        if (node.attribs.style && htmlStyleHasResources(node.attribs.style)) {
          const css = await resolveHtmlStyleResources(`x{${node.attribs.style}}`, resources);
          node.attribs.style = css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));
        }
        await visit(node.children);
      }
    }
  };
  await visit(document.children);
  return DomUtils.getOuterHTML(document.children);
}
