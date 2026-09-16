import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import {
  hasVideoReference,
  shotGenerationPayload,
} from "./generationInputs";
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
          if (hasVideoReference(card)) continue;
          const payload = shotGenerationPayload(card, board.episode, {
            maxImages: videoWorkflow.maxImages,
            defaultResolution: videoWorkflow.defaultResolution,
          });
          if (!payload) continue;
          const missing: string[] = [];
          for (const reference of [...payload.imageRefs, ...payload.audioRefs]) {
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

  const toggle = (shotId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });

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
          <div className="batch-shot-list">
            {candidates.map((item) => (
              <label key={item.shotId} className="batch-shot-row">
                <input
                  type="checkbox"
                  checked={selected.has(item.shotId)}
                  disabled={busy || submitting}
                  onChange={() => toggle(item.shotId)}
                />
                <code>{item.shotId}</code>
                <span>{item.shotTitle || "—"}</span>
                <small>
                  {item.duration}s · {item.resolution} · 图
                  {item.imageRefs.length}
                </small>
              </label>
            ))}
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
          <span className="muted">
            {ui.batch.selected(selected.size)}
          </span>
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
