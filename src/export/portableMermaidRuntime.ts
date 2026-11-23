import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);

export async function buildPortableMermaidPayload(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter(name => /^chunk-[a-z0-9]+\.js$/.test(name)).sort();
  const loader = await readFile(path.join(directory, 'loader.js'), 'utf8');
  const modules = await Promise.all(['core.js', 'elk-worker-source.js', ...names].map(async name => {
    const source = await readFile(path.join(directory, name), 'utf8');
    return `[${JSON.stringify(name)}, function () {\n${source}\n}]`;
  }));
  const program = `${loader}\n(() => {
    const modules = new Map([${modules.join(',\n')}]);
    const loader = globalThis.__meoMermaidSystem;
    const base = 'https://mermaid.invalid/';
    loader.instantiate = function (url) {
      const register = url.startsWith(base) && modules.get(url.slice(base.length));
      if (!register) throw new Error('Missing embedded Mermaid module: ' + url);
      register();
      return this.getRegister();
    };
    globalThis.__MEO_EMBEDDED_MERMAID__ = loader.import(base + 'core.js').then(module => {
      globalThis.mermaid = module.default;
      return module.default;
    });
  })();`;
  return (await compress(program)).toString('base64');
}
