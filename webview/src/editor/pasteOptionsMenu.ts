import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, Transaction } from '@codemirror/state';
import { BlockType, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { getUiStrings } from '../application/uiLanguage';
import { editorViewportBounds } from './editorViewportBounds';
import { uiLanguageFacet } from './uiLanguage';

type PasteAlternatives = { readonly formatted: string; readonly plain: string };
type PasteOffer = PasteAlternatives & {
  readonly from: number;
  readonly to: number;
};
type AcceptedPaste = PasteOffer & {
  readonly transaction: Transaction;
  readonly inserted: string;
};

export const pasteOptionsMenu = ViewPlugin.fromClass(class {
  private pending: PasteOffer | null = null;
  private accepted: AcceptedPaste | null = null;
  private popup: HTMLElement | null = null;
  private trigger: HTMLButtonElement | null = null;
  private menu: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private ctrlPressed = false;
  private focusFirst = false;

  constructor(private readonly view: EditorView) {}

  offer(alternatives: PasteAlternatives) {
    const { from, to } = this.view.state.selection.main;
    const offer = { ...alternatives, from, to };
    this.pending = offer;
    // Native CodeMirror paste dispatches synchronously when ClipboardData is
    // available. An unhandled event must not arm a future unrelated paste.
    queueMicrotask(() => { if (this.pending === offer) this.pending = null; });
  }

  update(update: ViewUpdate) {
    const pending = this.pending;
    if (update.docChanged || !update.startState.selection.eq(update.state.selection)
      || update.transactions.some(transaction => transaction.reconfigured)) this.close();
    const transaction = update.transactions.length === 1 ? update.transactions[0] : null;
    if (pending && transaction?.docChanged && transaction.isUserEvent('input.paste')) {
      let accepted: AcceptedPaste | null = null;
      let changeCount = 0;
      transaction.changes.iterChanges((from, to, start, end, text) => {
        changeCount++;
        if (from !== pending.from || to !== pending.to
          || !transaction.newSelection.eq(EditorSelection.single(end))) return;
        const inserted = text.toString();
        if (pending.formatted === inserted && pending.plain === inserted) return;
        accepted = { ...pending, from: start, to: end, transaction, inserted };
      });
      if (changeCount === 1 && accepted) {
        this.accepted = accepted;
        this.mount();
        return;
      }
    }
    if (this.popup && (update.geometryChanged || update.viewportChanged)) this.position();
  }

  private mount() {
    const doc = this.view.dom.ownerDocument;
    const labels = getUiStrings(this.view.state.facet(uiLanguageFacet));
    const popup = doc.createElement('div');
    popup.className = 'meo-paste-options';
    popup.style.visibility = 'hidden';
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'meo-paste-options-trigger';
    trigger.textContent = labels.pasteOptions + ' ▾';
    trigger.setAttribute('aria-label', labels.pasteOptions);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-keyshortcuts', 'Control');
    trigger.addEventListener('click', this.openMenu);
    const menu = doc.createElement('div');
    menu.className = 'meo-paste-options-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', labels.pasteOptions);
    const paste = this.accepted!;
    for (const [mode, label] of [['formatted', labels.pasteKeepFormatting], ['plain', labels.pasteKeepText]] as const) {
      const option = doc.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.textContent = label;
      option.dataset.pasteMode = mode;
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(paste[mode] === paste.inserted));
      option.addEventListener('click', () => this.apply(mode));
      menu.append(option);
    }
    popup.append(trigger, menu);
    doc.body.append(popup);
    this.popup = popup;
    this.trigger = trigger;
    this.menu = menu;
    this.listeners = new AbortController();
    const options = { capture: true, signal: this.listeners.signal };
    doc.addEventListener('keydown', this.onKeyDown, options);
    doc.addEventListener('keyup', this.onKeyUp, options);
    doc.addEventListener('pointerdown', this.onOutsideInteraction, options);
    doc.addEventListener('focusin', this.onOutsideInteraction, options);
    doc.addEventListener('compositionstart', this.onWindowBlur, options);
    doc.addEventListener('scroll', this.onScroll, options);
    doc.defaultView?.addEventListener('blur', this.onWindowBlur, { signal: this.listeners.signal });
    this.position();
  }

  private openMenu = () => {
    if (!this.menu || !this.trigger) return;
    this.menu.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.focusFirst = this.popup?.style.visibility === 'hidden';
    if (!this.focusFirst) this.focusOption();
    this.position();
  };

  private focusOption() {
    (this.menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      this.menu?.querySelector('button'))?.focus({ preventScroll: true });
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || this.view.compositionStarted) { this.close(); return; }
    if (event.key === 'Control' && !event.repeat && !event.altKey && !event.metaKey && !event.shiftKey) {
      this.ctrlPressed = true;
      return;
    }
    this.ctrlPressed = false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.target === this.trigger && this.menu?.hidden) {
        event.preventDefault();
        this.openMenu();
      } else if (this.menu && !this.menu.hidden && this.popup?.contains(event.target as Node)) {
        event.preventDefault();
        const options = Array.from(this.menu.querySelectorAll('button'));
        const current = options.indexOf(event.target as HTMLButtonElement);
        const next = current + (event.key === 'ArrowDown' ? 1 : -1);
        options[(next + options.length) % options.length]?.focus({ preventScroll: true });
      }
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Control' && this.ctrlPressed) {
      this.ctrlPressed = false;
      if (this.menu?.hidden) this.openMenu();
    }
  };

  private onOutsideInteraction = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Node) || this.popup?.contains(target)) return;
    if (event.type === 'focusin' && target === this.view.contentDOM) return;
    this.close();
  };

  private onWindowBlur = () => this.close();
  private onScroll = () => this.position();

  private position() {
    const popup = this.popup;
    const paste = this.accepted;
    if (!popup || !paste) return;
    this.view.requestMeasure({
      key: this,
      read: view => {
        const head = paste.transaction.newSelection.main.head;
        const coords = view.coordsAtPos(head);
        const bounds = editorViewportBounds(view);
        const viewport = view.dom.ownerDocument.documentElement;
        const left = Math.max(8, bounds.left + 4);
        const right = Math.min(viewport.clientWidth - 8, bounds.right - 4);
        const top = Math.max(8, bounds.top + 4);
        const bottom = Math.min(viewport.clientHeight - 8, bounds.bottom - 4);
        const { width, height } = popup.getBoundingClientRect();
        if (!coords || coords.right < bounds.left || coords.left > bounds.right
          || coords.bottom <= top || coords.top >= bottom || right - left < width) return null;
        const block = view.lineBlockAt(head);
        const rendered = block.type === BlockType.WidgetRange;
        // A rendered block's caret can resolve to the far edge of a full-width
        // widget. Its visible start is the closer anchor for the paste action.
        const anchorLeft = rendered ? view.coordsAtPos(block.from)?.left ?? coords.left : coords.left;
        const above = coords.top - 4 - height;
        const y = coords.bottom + 4 + height <= bottom ? coords.bottom + 4
          : rendered && above < top ? bottom - height : above;
        if (y < top) return null;
        return { x: Math.max(left, Math.min(anchorLeft, right - width)), y };
      },
      write: position => {
        if (this.popup !== popup) return;
        if (!position) { this.close(true); return; }
        popup.style.left = position.x + 'px';
        popup.style.top = position.y + 'px';
        popup.style.visibility = '';
        if (this.focusFirst) {
          this.focusFirst = false;
          this.focusOption();
        }
      }
    });
  }

  private apply(mode: keyof PasteAlternatives) {
    const paste = this.accepted;
    const state = this.view.state;
    this.close();
    if (!paste || state.doc !== paste.transaction.newDoc
      || !state.selection.eq(paste.transaction.newSelection) || this.view.compositionStarted
      || state.readOnly || !this.view.contentDOM.isContentEditable) return;
    const insert = paste[mode];
    if (insert !== paste.inserted) {
      // A replacement of the same range joins the original CodeMirror paste
      // entry, even after the user has taken time to decide in the menu.
      this.view.dispatch({
        changes: { from: paste.from, to: paste.to, insert },
        selection: EditorSelection.cursor(paste.from + insert.length),
        annotations: [Transaction.userEvent.of('input.type.paste-option'),
          Transaction.time.of(paste.transaction.annotation(Transaction.time)!), isolateHistory.of('after')],
        scrollIntoView: true
      });
    }
    this.view.focus();
  }

  private close(restoreFocus = false) {
    const wasFocused = this.popup?.contains(this.view.dom.ownerDocument.activeElement);
    this.listeners?.abort();
    this.popup?.remove();
    this.pending = this.accepted = this.listeners = this.popup = this.trigger = this.menu = null;
    this.ctrlPressed = this.focusFirst = false;
    if (restoreFocus && wasFocused) this.view.focus();
  }

  destroy() { this.close(); }
});
