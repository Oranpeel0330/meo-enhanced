import * as vscode from 'vscode';
import type { DocumentStatisticsReport } from '../protocol/documentStatistics';

export function createVscodeDocumentStatistics(panel: vscode.WebviewPanel, language: () => string) {
  const item = vscode.window.createStatusBarItem('meoEnhanced.documentStatistics', vscode.StatusBarAlignment.Right, 100);
  item.name = 'MEO Enhanced: Document Statistics';
  let statistics: DocumentStatisticsReport | null = null;
  const refresh = () => {
    if (!panel.active || !statistics) { item.hide(); return; }
    const s = statistics, zh = language() === 'zh-CN';
    const n = (value: number) => value.toLocaleString(zh ? 'zh-CN' : 'en-US');
    const lines = n(s.lines);
    const line = s.line === null ? '—' : n(s.line);
    const lineUnit = zh ? '行' : s.lines === 1 ? ' line' : ' lines';
    const lineDetails = s.line === null
      ? (zh ? `预览模式，共 ${lines} 行` : `Preview mode, ${lines}${lineUnit} total`)
      : (zh ? `当前第 ${line} 行，共 ${lines} 行` : `Current line ${line}, ${lines}${lineUnit} total`);
    let count: string;
    let wordDetails: string;
    let explanation: string;
    if ('wordCountStatus' in s) {
      count = zh ? '—/—字' : '—/— words';
      wordDetails = zh ? '字数暂不可用' : 'Word count unavailable';
      explanation = zh
        ? '字数统计已暂停，以保持编辑响应。'
        : 'Word counting is paused to keep editing responsive.';
    } else {
      const words = n(s.words);
      const selected = s.line === null ? '—' : n(s.selectedWords);
      const wordUnit = zh ? '字' : s.words === 1 ? ' word' : ' words';
      count = `${selected}/${words}${wordUnit}`;
      wordDetails = s.line === null
        ? (zh ? `选中字数不可用，共 ${words} 字` : `Selection count unavailable, ${words}${wordUnit} total`)
        : (zh ? `当前选中 ${selected} 字，共 ${words} 字`
          : `${selected} ${s.selectedWords === 1 ? 'word' : 'words'} selected, ${words}${wordUnit} total`);
      explanation = zh
        ? '行数按源码换行计算。中日韩逐字，其他语言逐词。计入代码文字，忽略 Markdown 标记、链接地址、HTML 标签和文档属性。'
        : 'Lines follow source line breaks. Counts CJK characters and other words, including code. Skips Markdown markup, link destinations, HTML tags and frontmatter.';
    }
    item.text = `${line}/${lines}${lineUnit}${zh ? '，' : ', '}${count}`;
    item.tooltip = new vscode.MarkdownString(`${lineDetails}  \n${wordDetails}\n***\n${explanation}`);
    item.accessibilityInformation = { label: `${lineDetails}${zh ? '。' : '. '}${wordDetails}` };
    item.show();
  };
  const subscription = panel.onDidChangeViewState(refresh);
  const configuration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('meoEnhanced.language')) refresh();
  });
  return { update(value: DocumentStatisticsReport | null) { statistics = value; refresh(); }, refresh,
    dispose() { subscription.dispose(); configuration.dispose(); item.dispose(); } };
}
