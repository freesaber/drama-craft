import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { hasSelectedVideo, shotGenerationPayload } from "./generationInputs";
import { ui } from "./i18n";
import type { VideoApiOptions } from "./videoWorkflows";
import type { BatchJobItemInput, Project, Storyboard } from "./types";

type Candidate = BatchJobItemInput & { missing: string[] };

export default function BatchGenerateDialog({
  project,
  document,
  board,
  videoWorkflow,
  busy,
  onClose,
  onCreated,
}: {
  project: Project;
  document: string;
  board: Storyboard;
  videoWorkflow: VideoApiOptions;
  busy: boolean;
  onClose: () => void;
  onCreated: (notice: string) => void;
}) {
  const [checking, setChecking] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delayHours, setDelayHours] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setChecking(true);
    setError("");
    void (async () => {
      try {
        const next: Candidate[] = [];
        for (const card of board.cards) {
          const videoRef = card.fields.videoFile.value.trim();
          if (videoRef) {
            try {
              const video = await api.media(project.handle, document, videoRef);
              if (hasSelectedVideo(card, video.exists)) continue;
            } catch {
              // Unreadable planned names are treated as not yet generated.
            }
          }
          const payload = shotGenerationPayload(card, board.episode, {
            maxImages: videoWorkflow.maxImages,
            defaultResolution: videoWorkflow.defaultResolution,
            resolutions: videoWorkflow.resolutions,
          });
          if (!payload) continue;
          const missing: string[] = [];
          for (const reference of [
            ...payload.imageRefs,
            ...payload.audioRefs,
          ]) {
            try {
              const media = await api.media(
                project.handle,
                document,
                reference,
              );
              if (!media.exists) missing.push(reference);
            } catch {
              missing.push(reference);
            }
          }
          next.push({ ...payload, missing });
        }
        if (!alive) return;
        const ready = next.filter((item) => !item.missing.length);
        setCandidates(ready);
        setSelected(new Set(ready.map((item) => item.shotId)));
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [board, document, project.handle, videoWorkflow]);

  const delayOptions = useMemo(
    () => Array.from({ length: 13 }, (_, hour) => hour),
    [],
  );
  const allSelected =
    candidates.length > 0 &&
    candidates.every((item) => selected.has(item.shotId));
  const someSelected = candidates.some((item) => selected.has(item.shotId));
  const selectAllRef = useRef<HTMLInputElement>(null);

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
      allSelected ? new Set() : new Set(candidates.map((item) => item.shotId)),
    );

  const submit = async () => {
    const items = candidates.filter((item) => selected.has(item.shotId));
    if (!items.length) return;
    setSubmitting(true);
    setError("");
    try {
      const name = `${ui.batch.typeGeneration} · ${document.split("/").at(-1) ?? document} · ${items.length}`;
      await api.createBatchJob(project.handle, {
        jobType: "generation",
        name,
        document,
        delayHours,
        items: items.map(
          ({
            shotId,
            shotTitle,
            prompt,
            duration,
            resolution,
            seed,
            imageRefs,
            audioRefs,
          }) => ({
            shotId,
            shotTitle,
            prompt,
            duration,
            resolution,
            seed,
            imageRefs,
            audioRefs,
          }),
        ),
      });
      onCreated(ui.batch.created);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal batch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-generate-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="batch-generate-title">{ui.batch.title}</h2>
        <p className="muted">{ui.batch.hint}</p>
        {checking ? (
          <p className="muted">{ui.batch.checking}</p>
        ) : candidates.length ? (
          <div className="batch-shot-table-wrap">
            <table className="batch-shot-table is-selectable">
              <thead>
                <tr>
                  <th className="batch-shot-check">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      disabled={busy || submitting}
                      aria-label={ui.batch.selectAll}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="batch-shot-id">{ui.batch.shotId}</th>
                  <th>{ui.batch.shotTitle}</th>
                  <th className="batch-shot-duration">{ui.batch.duration}</th>
                  <th className="batch-shot-resolution">
                    {ui.batch.resolution}
                  </th>
                  <th className="batch-shot-images">{ui.batch.images}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((item) => {
                  const checked = selected.has(item.shotId);
                  return (
                    <tr
                      key={item.shotId}
                      className={checked ? "is-selected" : ""}
                      onClick={() => {
                        if (!busy && !submitting) toggle(item.shotId);
                      }}
                    >
                      <td className="batch-shot-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || submitting}
                          aria-label={item.shotId}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggle(item.shotId)}
                        />
                      </td>
                      <td className="batch-shot-id">
                        <code>{item.shotId}</code>
                      </td>
                      <td
                        className="batch-shot-title"
                        title={item.shotTitle || undefined}
                      >
                        {item.shotTitle || "—"}
                      </td>
                      <td className="batch-shot-duration">{item.duration}s</td>
                      <td
                        className="batch-shot-resolution"
                        title={item.resolution}
                      >
                        {item.resolution}
                      </td>
                      <td className="batch-shot-images">
                        {item.imageRefs.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{ui.batch.empty}</p>
        )}
        <label>
          {ui.batch.delay}
          <select
            value={delayHours}
            disabled={busy || submitting}
            onChange={(event) => setDelayHours(Number(event.target.value))}
          >
            {delayOptions.map((hour) => (
              <option key={hour} value={hour}>
                {hour === 0 ? ui.batch.delayNow : ui.batch.delayHours(hour)}
              </option>
            ))}
          </select>
        </label>
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
            {submitting ? ui.busy : ui.batch.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
