import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import { withMediaRevision } from "./mediaUrl";
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

function MergePreview({
  project,
  document,
  row,
}: {
  project: Project;
  document: string;
  row: Row | undefined;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc("");
    setError("");
    setFailed(false);
    if (!row?.exists || !row.localFile) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api
      .media(project.handle, document, row.localFile)
      .then((media) => {
        if (!alive) return;
        if (!media.exists || !media.path || media.kind !== "video") return;
        setSrc(withMediaRevision(convertFileSrc(media.path), media.revision));
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [project.handle, document, row?.shotId, row?.localFile, row?.exists]);

  if (!row) {
    return <div className="merge-preview-empty">{ui.batch.mergePreviewEmpty}</div>;
  }

  return (
    <div className="merge-preview-stage">
      <div className="merge-preview-meta">
        <strong>
          {row.shotId}
          {row.shotTitle ? ` · ${row.shotTitle}` : ""}
        </strong>
        <span title={row.localFile || undefined}>
          {row.exists ? row.localFile : ui.batch.missingVideo}
        </span>
      </div>
      {error && (
        <p className="generation-error" role="alert">
          {error}
        </p>
      )}
      {src && !failed ? (
        <video
          key={src}
          className="merge-preview-player"
          src={src}
          controls
          playsInline
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="merge-preview-empty">
          {loading
            ? ui.batch.checking
            : failed
              ? ui.decodeError
              : ui.batch.mergePreviewEmpty}
        </div>
      )}
    </div>
  );
}

export default function MergeDialog({
  project,
  document,
  board,
  busy,
  mergeRunning,
  onClose,
  onCreated,
}: {
  project: Project;
  document: string;
  board: Storyboard;
  busy: boolean;
  mergeRunning: boolean;
  onClose: () => void;
  onCreated: (notice: string) => void;
}) {
  const [checking, setChecking] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const selectable = rows.filter((row) => row.exists);
  const allSelected =
    selectable.length > 0 && selectable.every((row) => selected.has(row.shotId));
  const someSelected = selectable.some((row) => selected.has(row.shotId));
  const selectAllRef = useRef<HTMLInputElement>(null);
  const active = rows.find((row) => row.shotId === activeId) ?? rows[0];

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
        setActiveId(next[0]?.shotId ?? "");
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
    if (submittingRef.current || busy || mergeRunning) return;
    const items = rows.filter((row) => row.exists && selected.has(row.shotId));
    if (!items.length) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const name = `${ui.batch.typeMerge} · ${document.split(/[/\\]/).at(-1) ?? document} · ${items.length}`;
      await api.mergeEpisode(project.handle, {
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
      onCreated(ui.batch.mergeQueued);
      onClose();
    } catch (e) {
      submittingRef.current = false;
      setSubmitting(false);
      setError(errorMessage(e));
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
        className="modal batch-modal merge-modal"
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
          <div className="merge-layout">
            <div className="batch-shot-table-wrap merge-list">
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
                    const current = row.shotId === active?.shotId;
                    return (
                      <tr
                        key={row.shotId}
                        className={[
                          !row.exists ? "is-disabled" : "",
                          current ? "is-active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => setActiveId(row.shotId)}
                      >
                        <td className="batch-shot-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy || submitting || !row.exists}
                            aria-label={row.shotId}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveId(row.shotId);
                            }}
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
            <aside className="merge-preview" aria-label={ui.batch.mergePreview}>
              <MergePreview
                project={project}
                document={document}
                row={active}
              />
            </aside>
          </div>
        ) : (
          <p className="muted">{ui.batch.mergeEmpty}</p>
        )}
        {mergeRunning && (
          <p className="muted" role="status">
            {ui.batch.mergeBusy}
          </p>
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
            disabled={busy || submitting || mergeRunning || !selected.size}
            onClick={() => void submit()}
          >
            {submitting ? ui.batch.merging : ui.batch.mergeConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
