import { useCallback, useRef, useState } from "react";
import { ui } from "./i18n";

export function useUnsavedChanges() {
  const [pending, setPending] = useState(false);
  const resolve = useRef<((answer: boolean) => void) | null>(null);
  const ask = useCallback(
    () =>
      new Promise<boolean>((answer) => {
        // Application file operations are serialized; never leave a displaced promise pending.
        resolve.current?.(false);
        resolve.current = answer;
        setPending(true);
      }),
    [],
  );
  const answer = (value: boolean) => {
    const callback = resolve.current;
    resolve.current = null;
    setPending(false);
    callback?.(value);
  };
  const dialog = pending ? (
    <div className="modal-backdrop" style={{ zIndex: 20 }}>
      <section
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
      >
        <h2 id="unsaved-title">{ui.dirtyTitle}</h2>
        <p>{ui.dirtyConfirm}</p>
        <div className="modal-actions">
          <button autoFocus onClick={() => answer(false)}>
            {ui.keepEditing}
          </button>
          <button className="primary-button" onClick={() => answer(true)}>
            {ui.discard}
          </button>
        </div>
      </section>
    </div>
  ) : null;
  return { ask, dialog };
}
