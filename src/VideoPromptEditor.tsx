import { useState } from "react";
import { errorMessage } from "./api";
import { ui } from "./i18n";

export default function VideoPromptEditor({
  value,
  disabled,
  save,
}: {
  value: string;
  disabled: boolean;
  save: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = draft !== null && draft.value !== value;
  const locked = disabled || saving;
  return (
    <section className="board-field generation-prompt-field">
      <div className="generation-prompt-heading">
        <span>{ui.board.videoPrompt}</span>
        <div className="generation-prompt-actions">
          <button
            type="button"
            disabled={locked || !dirty}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
          >
            {ui.generation.undoPrompt}
          </button>
          <button
            type="button"
            disabled={locked || !dirty}
            onClick={() => {
              if (!draft) return;
              if (draft.base !== value) {
                setError(ui.board.stale);
                return;
              }
              setSaving(true);
              setError("");
              void Promise.resolve()
                .then(() => save(draft.value))
                .then(() => setDraft(null))
                .catch((cause) => {
                  setError(errorMessage(cause));
                })
                .finally(() => setSaving(false));
            }}
          >
            {ui.save}
          </button>
        </div>
      </div>
      <textarea
        className="generation-prompt-editor"
        aria-label={ui.board.videoPrompt}
        disabled={locked}
        value={draft?.value ?? value}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(
            next === value ? null : { base: draft?.base ?? value, value: next },
          );
          setError("");
        }}
      />
      {error && (
        <p className="diagnostic" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
