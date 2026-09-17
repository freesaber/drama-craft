import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type { Project, ShotCard, Storyboard } from "./types";

type Row = {
  shotId: string;
  shotTitle: string;
  localFile: string;
  duration: number;
  resolution: string;
  exists: boolean;
};

function durationOf(card: ShotCard) {
  const value = Number(card.fields.duration.value || "5");
  if (!Number.isInteger(value) || value < 1 || value > 15) return 5;
  return value;
}

export default function MergeDialog({
  project,
  document,
  board,
  busy,
  onClose,
  onCreated,
}: {
  project: Project;
  document: string;
  board: Storyboard;
  busy: boolean;
  onClose: () => void;
  onCreated: (notice: string) => void;
}) {
  const [checking, setChecking] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selectable = rows.filter((row) => row.exists);
  const allSelected =
    selectable.length > 0 && selectable.every((row) => selected.has(row.shotId));
  const someSelected = selectable.some((row) => selected.has(row.shotId));
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setChecking(true);
    setError("");
    void (async () => {
      try {
        const next: Row[] = [];
        const checked = new Set<string>();
        for (const card of board.cards) {
          const localFile = card.fields.videoFile.value.trim();
          let exists = false;
          if (localFile) {
            try {
              const media = await api.media(project.handle, document, localFile);
              exists = Boolean(media.exists && media.kind === "video");
            } catch {
              exists = false;
            }
          }
          next.push({
            shotId: card.id,
            shotTitle: card.title,
            localFile,
            duration: durationOf(card),
            resolution: card.fields.resolution.value || "—",
            exists,
          });
          if (exists) checked.add(card.id);
        }
        if (!alive) return;
        setRows(next);
        setSelected(checked);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [board, document, project.handle]);

  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [allSelected, someSelected]);

  const toggle = (shotId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });

  const toggleAll = () =>
    setSelected(
      allSelected ? new Set() : new Set(selectable.map((row) => row.shotId)),
    );

  const submit = async () => {
    const items = rows.filter((row) => row.exists && selected.has(row.shotId));
    if (!items.length) return;
    setSubmitting(true);
    setError("");
    try {
      const name = `${ui.batch.typeMerge} · ${document.split(/[/\\]/).at(-1) ?? document} · ${items.length}`;
      const job = await api.mergeEpisode(project.handle, {
        document,
        name,
        items: items.map((item) => ({
          shotId: item.shotId,
          shotTitle: item.shotTitle,
          localFile: item.localFile,
          duration: item.duration,
          resolution: item.resolution,
        })),
      });
      if (job.status === "failed") {
        onCreated("");
        throw new Error(
          job.items.find((item) => item.error)?.error || ui.errors.unknown,
        );
      }
      onCreated(ui.batch.mergeCreated);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="modal batch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-merge-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="batch-merge-title">{ui.batch.mergeTitle}</h2>
        <p className="muted">{ui.batch.mergeHint}</p>
        {checking ? (
          <p className="muted">{ui.batch.checking}</p>
        ) : rows.length ? (
          <div className="batch-shot-table-wrap">
            <table className="batch-shot-table is-selectable">
              <thead>
                <tr>
                  <th className="batch-shot-check">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      disabled={busy || submitting || !selectable.length}
                      aria-label={ui.batch.selectAll}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="batch-shot-id">{ui.batch.shotId}</th>
                  <th>{ui.batch.shotTitle}</th>
                  <th>{ui.batch.currentVideo}</th>
                  <th className="batch-shot-duration">{ui.batch.duration}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const checked = selected.has(row.shotId);
                  return (
                    <tr
                      key={row.shotId}
                      className={
                        !row.exists ? "is-disabled" : checked ? "is-selected" : ""
                      }
                      onClick={() => {
                        if (!busy && !submitting && row.exists) toggle(row.shotId);
                      }}
                    >
                      <td className="batch-shot-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || submitting || !row.exists}
                          aria-label={row.shotId}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => {
                            if (row.exists) toggle(row.shotId);
                          }}
                        />
                      </td>
                      <td className="batch-shot-id">
                        <code>{row.shotId}</code>
                      </td>
                      <td
                        className="batch-shot-title"
                        title={row.shotTitle || undefined}
                      >
                        {row.shotTitle || "—"}
                      </td>
                      <td
                        className="batch-shot-title"
                        title={row.localFile || undefined}
                      >
                        {row.exists
                          ? row.localFile
                          : row.localFile
                            ? `${row.localFile}（${ui.batch.missingVideo}）`
                            : ui.batch.missingVideo}
                      </td>
                      <td className="batch-shot-duration">{row.duration}s</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{ui.batch.mergeEmpty}</p>
        )}
        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="muted">{ui.batch.selected(selected.size)}</span>
          <button type="button" disabled={busy || submitting} onClick={onClose}>
            {ui.cancel}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || submitting || !selected.size}
            onClick={() => void submit()}
          >
            {submitting ? ui.batch.merging : ui.batch.mergeConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
