'use client';

import { useEffect, useRef, useState } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogPortalOptions {
  /**
   * A selector for one element the dialog deliberately leaves interactive.
   *
   * The promote sheet is anchored beside the private agent column rather
   * than over it, precisely so the work being promoted stays readable and
   * copyable while the sheet is open. `inert` is inherited and cannot be
   * un-set on a descendant, so the covered set is computed by walking from
   * that element up to the body and marking its siblings at each level,
   * leaving its ancestors (and therefore the element itself) live.
   *
   * Tab is still trapped inside the dialog by the handler below: a keyboard
   * user who tabs out of a dialog has almost always lost their place rather
   * than chosen to leave.
   *
   * Decided trade, not an oversight: the dialog still sets aria-modal, which
   * tells assistive tech to prune everything outside it, so the exempted
   * column is pointer-live but announced-out for screen-reader users during
   * promote. Accepted because the drafts picker removes most reasons to
   * reach into the column at all, and dropping aria-modal would weaken the
   * dialog semantics for every assistive-tech user to serve a case the
   * picker already covers. Revisit if the column ever carries something a
   * promote genuinely depends on that the picker cannot supply.
   */
  keepInteractive?: string;
}

/**
 * The two modal surfaces in this app (promote, fork) share one problem and
 * one fix.
 *
 * The problem: `.agent-pane` carries a backdrop-filter, which makes it the
 * containing block for `position: fixed` descendants, so a modal rendered in
 * place is clipped to the sidebar. Both modals therefore portal out to a
 * container appended to `document.body`.
 *
 * Once a modal is a sibling of the whole app rather than a child of the
 * thing that opened it, nothing keeps a keyboard user inside it: Tab walks
 * straight out into the page behind the scrim, which is still fully
 * interactive. So this hook also owns the dialog behaviour that has to come
 * with the portal — focus moved in on open and restored on close, Escape,
 * a Tab cycle that wraps inside the box, and `inert` on everything the
 * modal is covering.
 *
 * Returns the portal container to render into and the ref to put on the
 * dialog box itself.
 */
/**
 * Everything the dialog covers, as a flat list of elements safe to mark
 * `inert`. With no exemption that is simply the body's children. With one,
 * it is every sibling on the path from the exempt element up to the body,
 * so the exempt element's ancestor chain stays live and the exemption
 * actually holds (inert cannot be reversed on a descendant).
 */
function collectCovered(keep: HTMLElement | null): HTMLElement[] {
  if (!keep || !document.body.contains(keep)) {
    return Array.from(document.body.children) as HTMLElement[];
  }
  const out: HTMLElement[] = [];
  let node: HTMLElement = keep;
  while (node.parentElement && node !== document.body) {
    const parent = node.parentElement;
    for (const sibling of Array.from(parent.children) as HTMLElement[]) {
      if (sibling !== node) out.push(sibling);
    }
    node = parent;
  }
  return out;
}

export function useDialogPortal(onRequestClose: () => void, options: DialogPortalOptions = {}) {
  const [container] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div'),
  );
  const boxRef = useRef<HTMLDivElement>(null);

  // Kept in a ref so the effect below runs exactly once per open, rather
  // than tearing down and re-establishing inertness on every render.
  const closeRef = useRef(onRequestClose);
  useEffect(() => {
    closeRef.current = onRequestClose;
  });

  // Read once per open for the same reason: the inert set is established on
  // mount and torn down on unmount, not re-derived on every render.
  const keepRef = useRef(options.keepInteractive);

  useEffect(() => {
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Everything the sheet covers goes behind the scrim. `inert` removes it
    // from the tab order and the accessibility tree in one attribute;
    // elements that were already inert are left alone so they stay inert on
    // cleanup. An opt-in exemption (the agent column, for promote) is
    // carved out by collectCovered.
    const keepSelector = keepRef.current;
    const keep = keepSelector ? document.querySelector<HTMLElement>(keepSelector) : null;
    const covered = collectCovered(keep).filter((el) => !el.hasAttribute('inert'));
    covered.forEach((el) => el.setAttribute('inert', ''));

    document.body.appendChild(container);

    // The box carries tabIndex={-1}, so it is a valid focus target when it
    // holds no focusable control of its own.
    const box = boxRef.current;
    const first = box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = boxRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? lastEl : firstEl).focus();
        return;
      }
      if (event.shiftKey && active === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      covered.forEach((el) => el.removeAttribute('inert'));
      container.remove();
      previouslyFocused?.focus?.();
    };
  }, [container]);

  return { container, boxRef };
}
