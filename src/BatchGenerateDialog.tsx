import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import {
  batchGenerationCandidates,
  batchItemResolution,
  batchResolutionOptions,
  type BatchGenerationCandidate,
} from "./batchGeneration";
import { ui } from "./i18n";
import type { GenerationSettings, Project, Storyboard } from "./types";

type Candidate = BatchGenerationCandidate;

export default function BatchGenerateDialog({
  project,
  document,
  board,
  generationSettings,
  busy,
  onClose,
  onCreated,
}: {
  project: Project;
  document: string;
  board: Storyboard;
  generationSettings: GenerationSettings;
  busy: boolean;
  onClose: () => void;
  onCreated: (notice: string) => void;
}) {
  const [checking, setChecking] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolutionOverride, setResolutionOverride] = useState("");
  const [delayHours, setDelayHours] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setChecking(true);
    setCandidates([]);
    setSelected(new Set());
    setError("");
    void (async () => {
      try {
        const next = await batchGenerationCandidates(
          project.handle,
          document,
          board,
          generationSettings,
        );
        if (!alive) return;
        setCandidates(next);
        setSelected(
          new Set(
            next
              .filter((item) => !item.missing.length && !item.hasVideo)
              .map((item) => item.shotId),
          ),
        );
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [board, document, project.handle, generationSettings]);

  const delayOptions = useMemo(
    () => Array.from({ length: 13 }, (_, hour) => hour),
    [],
  );
  const selectable = candidates.filter((item) => !item.missing.length);
  const items = selectable.filter((item) => selected.has(item.shotId));
  const resolutionOptions = batchResolutionOptions(
    items.length ? items : selectable,
  );
  const incompatibleOverride = Boolean(
    resolutionOverride && !resolutionOptions.includes(resolutionOverride),
  );
  const canKeepPreviousResolution = items.every((item) =>
    batchItemResolution(item),
  );
  const resolutionRequired = !resolutionOverride && !canKeepPreviousResolution;
  const allSelected =
    selectable.length > 0 &&
    selectable.every((item) => selected.has(item.shotId));
  const someSelected = candidates.some((item) => selected.has(item.shotId));
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [allSelected, someSelected]);

  const toggle = (shotId: string) => {
    if (!selectable.some((item) => item.shotId === shotId)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });
  };

  const toggleAll = () =>
    setSelected(
      allSelected ? new Set() : new Set(selectable.map((item) => item.shotId)),
    );

  const submit = async () => {
    if (
      checking ||
      busy ||
      submitting ||
      incompatibleOverride ||
      resolutionRequired
    )
      return;
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
            seed,
            imageRefs,
            audioRefs,
            sourceTaskId,
            previousResolution,
            resolutions,
          }) => ({
            shotId,
            shotTitle,
            prompt,
            duration,
            resolution: batchItemResolution(
              { previousResolution, resolutions },
              resolutionOverride,
            ),
            seed,
            imageRefs,
            audioRefs,
            sourceTaskId,
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
        className="modal batch-modal generation-batch-modal"
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
                      disabled={busy || submitting || !selectable.length}
                      aria-label={ui.batch.selectAll}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="batch-shot-id">{ui.batch.shotId}</th>
                  <th>{ui.batch.shotTitle}</th>
                  <th className="batch-shot-duration">{ui.batch.duration}</th>
                  <th className="batch-shot-resolution">
                    {ui.batch.previousResolution}
                  </th>
                  <th className="batch-shot-images">{ui.batch.images}</th>
                  <th className="batch-shot-api">{ui.generation.submitApi}</th>
                  <th className="batch-shot-status">{ui.batch.statusLabel}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((item) => {
                  const checked = selected.has(item.shotId);
                  const disabled = busy || submitting || !!item.missing.length;
                  return (
                    <tr
                      key={item.shotId}
                      className={
                        item.missing.length
                          ? "is-disabled"
                          : checked
                            ? "is-selected"
                            : ""
                      }
                      onClick={() => {
                        if (!disabled) toggle(item.shotId);
                      }}
                    >
                      <td className="batch-shot-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
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
                        title={item.previousResolution}
                      >
                        {item.previousResolution || "—"}
                      </td>
                      <td className="batch-shot-images">
                        {item.imageRefs.length}
                      </td>
                      <td className="batch-shot-api" title={item.apiName}>
                        {item.apiName || ui.generation.unknownApi}
                      </td>
                      <td className="batch-shot-status">
                        <span>
                          {item.hasVideo
                            ? ui.batch.generatedVideo
                            : ui.batch.missingVideo}
                        </span>
                        {item.missing.length > 0 && (
                          <div className="generation-error">
                            {ui.batch.missingAssets}：{item.missing.join("、")}
                          </div>
                        )}
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
        <div className="generation-batch-options">
          <label>
            {ui.batch.resolutionOverride}
            <select
              value={resolutionOverride}
              disabled={checking || busy || submitting}
              onChange={(event) => setResolutionOverride(event.target.value)}
            >
              <option value="">
                {canKeepPreviousResolution
                  ? ui.batch.keepPreviousResolution
                  : ui.batch.chooseResolution}
              </option>
              {incompatibleOverride && (
                <option value={resolutionOverride} disabled>
                  {resolutionOverride}
                </option>
              )}
              {resolutionOptions.map((resolution) => (
                <option key={resolution} value={resolution}>
                  {resolution}
                </option>
              ))}
            </select>
          </label>
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
        </div>
        {incompatibleOverride && (
          <p className="generation-error" role="alert">
            {ui.batch.incompatibleResolution}
          </p>
        )}
        {resolutionRequired && (
          <p className="muted">
            {resolutionOptions.length
              ? ui.batch.requireBatchResolution
              : ui.batch.noCommonResolution}
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
            disabled={
              checking ||
              busy ||
              submitting ||
              !items.length ||
              incompatibleOverride ||
              resolutionRequired
            }
            onClick={() => void submit()}
          >
            {submitting ? ui.busy : ui.batch.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
