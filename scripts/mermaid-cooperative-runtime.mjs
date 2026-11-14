import { readFileSync } from 'node:fs';

/** Patch the pinned upstream DOM renderer at its existing async boundaries.
 * Checked replacements fail the build if an upgrade changes those boundaries. */
function cooperativeMermaidRenderer(source, taskModule) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Mermaid cooperative render boundary changed');
    source = source.replace(before, after);
  };
  replace('  await Promise.all(\n    data4Layout.nodes.map(async (node) => {',
    '  await forEachMermaidRenderItem(data4Layout.nodes, async (node) => {');
  replace('    })\n  );\n  for (const edge of edgesToProcess) {',
    '    });\n  for (const edge of edgesToProcess) {\n    await checkpointMermaidRender();');
  replace('    const measure = false ?', '    await yieldMermaidRenderTask();\n    const measure = false ?');
  replace('    const coreResult = false ?', '    await yieldMermaidRenderTask();\n    const coreResult = false ?');
  replace('    const paintContext = {', '    await yieldMermaidRenderTask();\n    const paintContext = {');
  replace('    await paintLayoutNode(groups, node, context, options);',
    '    await checkpointMermaidRender();\n    await paintLayoutNode(groups, node, context, options);');
  replace('    await paintLayoutEdge(groups, edge, nodeById, data4Layout, options, context);',
    '    await checkpointMermaidRender();\n    await paintLayoutEdge(groups, edge, nodeById, data4Layout, options, context);');
  return `import { forEachMermaidRenderItem, checkpointMermaidRender, yieldMermaidRenderTask } from ${JSON.stringify(taskModule)};\n${source}`;
}

export function cooperativeMermaidPlugin(taskModule) {
  let patched = false;
  return {
    plugin: { name: 'mermaid-cooperative-dom', setup(builder) {
      builder.onLoad({ filter: /mermaid[\\/]dist[\\/]chunks[\\/].*\.mjs$/ }, args => {
        const source = readFileSync(args.path, 'utf8');
        if (!source.includes('function createCommonLayoutRenderer(')) return;
        if (patched) throw new Error('Multiple Mermaid common DOM renderers');
        patched = true;
        return { contents: cooperativeMermaidRenderer(source, taskModule), loader: 'js' };
      });
    } },
    verify() { if (!patched) throw new Error('Mermaid common DOM renderer was not found'); }
  };
}
