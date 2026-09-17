import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type { BatchJob, Project } from "./types";
import VideoPlayerModal from "./VideoPlayerModal";

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function documentName(path: string) {
  return path.split(/[/\\]/).at(-1) || path;
}

function statusTone(status: string) {
  const key = status.toLowerCase();
  if (["failed", "error", "download_failed"].includes(key)) return "is-failed";
  if (["completed", "success", "succeeded"].includes(key)) return "is-done";
  if (key === "cancelled") return "is-muted";
  return "";
}

export default function TaskListView({
  project,
  jobs,
  busy,
  onBack,
  onRefresh,
  onJobsChange,
}: {
  project: Project;
  jobs: BatchJob[];
  busy: boolean;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onJobsChange: (jobs: BatchJob[]) => void;
}) {
  const [filter, setFilter] = useState<"all" | "generation" | "merge">("all");
  const [detail, setDetail] = useState<BatchJob | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);

  const visible = useMemo(
    () =>
      filter === "all" ? jobs : jobs.filter((job) => job.jobType === filter),
    [filter, jobs],
  );

  useEffect(() => {
    if (!detail) return;
    const next = jobs.find((job) => job.jobId === detail.jobId);
    if (next) setDetail(next);
  }, [jobs, detail]);

  const run = async (action: () => Promise<void>) => {
    setActing(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setActing(false);
    }
  };

  const cancelJob = (jobId: string) =>
    void run(async () => {
      if (!window.confirm(ui.batch.cancelConfirm)) return;
      const next = await api.cancelBatchJob(project.handle, jobId);
      onJobsChange(jobs.map((job) => (job.jobId === next.jobId ? next : job)));
      setDetail(next);
    });

  const cancelItem = (itemId: string) =>
    void run(async () => {
      const next = await api.cancelBatchJobItem(project.handle, itemId);
      onJobsChange(jobs.map((job) => (job.jobId === next.jobId ? next : job)));
      setDetail(next);
    });

  return (
    <main className="workspace task-workspace">
      <div className="panel-heading task-heading">
        <div>
          <strong>{ui.batch.tasks}</strong>
          <small>{project.metadata.name}</small>
        </div>
        <div className="mode-switch" aria-label={ui.batch.tasks}>
          <button
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            {ui.batch.filterAll}
          </button>
          <button
            aria-pressed={filter === "generation"}
            onClick={() => setFilter("generation")}
          >
            {ui.batch.typeGeneration}
          </button>
          <button
            aria-pressed={filter === "merge"}
            onClick={() => setFilter("merge")}
          >
            {ui.batch.typeMerge}
          </button>
        </div>
        <div className="save-actions">
          <button disabled={busy || acting} onClick={() => void onRefresh()}>
            {ui.refresh}
          </button>
          <button className="primary-button" disabled={busy} onClick={onBack}>
            {ui.batch.back}
          </button>
        </div>
      </div>
      {error && (
        <div className="banner conflict" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="batch-shot-table-wrap task-table-wrap">
        <table className="batch-shot-table task-table is-selectable">
          <thead>
            <tr>
              <th>{ui.batch.jobName}</th>
              <th className="task-table-type">{ui.batch.typeLabel}</th>
              <th className="task-table-status">{ui.batch.statusLabel}</th>
              <th className="task-table-progress">{ui.batch.progressLabel}</th>
              <th className="task-table-time">{ui.batch.scheduledAt}</th>
              <th className="task-table-document">{ui.batch.document}</th>
              <th className="task-table-actions">{ui.batch.actions}</th>
            </tr>
          </thead>
          <tbody>
            {!visible.length && (
              <tr className="task-table-empty">
                <td colSpan={7}>{ui.batch.emptyJobs}</td>
              </tr>
            )}
            {visible.map((job) => (
              <tr key={job.jobId} onClick={() => setDetail(job)}>
                <td className="task-table-name" title={job.name}>
                  {job.name}
                </td>
                <td className="task-table-type">
                  {ui.batch.type(job.jobType)}
                </td>
                <td className={`task-table-status ${statusTone(job.status)}`}>
                  {ui.generation.status(job.status)}
                </td>
                <td className="task-table-progress">
                  {ui.batch.progress(job.itemCompleted, job.itemTotal)}
                </td>
                <td className="task-table-time">
                  {formatTime(job.scheduledAt)}
                </td>
                <td className="task-table-document" title={job.document}>
                  {documentName(job.document)}
                </td>
                <td
                  className="task-table-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button type="button" onClick={() => setDetail(job)}>
                    {ui.batch.openDetail}
                  </button>
                  {["scheduled", "running"].includes(job.status) && (
                    <button
                      type="button"
                      disabled={busy || acting}
                      onClick={() => cancelJob(job.jobId)}
                    >
                      {ui.batch.cancelJob}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div
            className="modal batch-modal task-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="task-detail-title">{detail.name}</h2>
            <p className="muted">
              {ui.batch.type(detail.jobType)} ·{" "}
              {ui.generation.status(detail.status)} · {ui.batch.scheduledAt}{" "}
              {formatTime(detail.scheduledAt)}
            </p>
            <p className="muted">
              {ui.batch.document}：{detail.document}
            </p>
            {detail.jobType === "merge" && detail.resultFile && (
              <p className="muted">
                {ui.batch.result}：{detail.resultFile}
              </p>
            )}
            <div className="generation-section-title">
              <span>{ui.batch.items}</span>
              <small>{detail.items.length}</small>
            </div>
            <div className="batch-shot-table-wrap">
              {!detail.items.length ? (
                <p className="muted">{ui.batch.noItems}</p>
              ) : (
                <table className="batch-shot-table">
                  <thead>
                    <tr>
                      <th className="batch-shot-id">{ui.batch.shotId}</th>
                      <th>{ui.batch.shotTitle}</th>
                      <th className="task-table-status">
                        {ui.batch.statusLabel}
                      </th>
                      <th className="task-table-error">
                        {ui.batch.errorReason}
                      </th>
                      <th>{ui.batch.result}</th>
                      <th className="task-table-actions">{ui.batch.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => (
                      <tr key={item.itemId}>
                        <td className="batch-shot-id">
                          <code>{item.shotId}</code>
                        </td>
                        <td
                          className="batch-shot-title"
                          title={item.shotTitle || undefined}
                        >
                          {item.shotTitle || "—"}
                        </td>
                        <td
                          className={`task-table-status ${statusTone(item.status)}`}
                        >
                          {ui.generation.status(item.status)}
                        </td>
                        <td
                          className="task-table-error"
                          title={item.error || undefined}
                        >
                          {item.error ? (
                            <span className="generation-error">
                              {item.error}
                            </span>
                          ) : item.status === "cancelled" ? (
                            <span className="muted">
                              {ui.batch.itemCancelled}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td
                          className="task-table-result"
                          title={item.localFile || undefined}
                        >
                          {item.localFile || "—"}
                        </td>
                        <td className="task-table-actions">
                          {item.status === "pending" && (
                            <button
                              type="button"
                              disabled={busy || acting}
                              onClick={() => cancelItem(item.itemId)}
                            >
                              {ui.batch.cancelItem}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="modal-actions">
              {detail.jobType === "merge" && detail.resultFile && (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setPlaying(detail.resultFile!)}
                >
                  {ui.batch.playResult}
                </button>
              )}
              {["scheduled", "running"].includes(detail.status) && (
                <button
                  type="button"
                  disabled={busy || acting}
                  onClick={() => cancelJob(detail.jobId)}
                >
                  {ui.batch.cancelJob}
                </button>
              )}
              <button type="button" onClick={() => setDetail(null)}>
                {ui.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
      {playing && detail && (
        <VideoPlayerModal
          project={project}
          document={detail.document}
          reference={playing}
          title={playing.replace(/.*[/\\]/, "")}
          onClose={() => setPlaying(null)}
        />
      )}
    </main>
  );
}
