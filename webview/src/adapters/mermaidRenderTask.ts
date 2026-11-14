/** Mermaid keeps its exclusive engine lease across these task boundaries.
 * Only detached measurement/painting is sliced; no partial SVG is published. */
let deadline = 0;

export async function yieldMermaidRenderTask(): Promise<void> {
  await new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
  deadline = performance.now() + 4;
}

export async function checkpointMermaidRender(): Promise<void> {
  if (performance.now() >= deadline) await yieldMermaidRenderTask();
}

export async function forEachMermaidRenderItem<T>(items: Iterable<T>, render: (item: T) => Promise<unknown>): Promise<void> {
  for (const item of items) {
    await checkpointMermaidRender();
    await render(item);
  }
}
