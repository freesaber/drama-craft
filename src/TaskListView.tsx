import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type { BatchJob, Project } from "./types";

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN");
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
      onJobsChange(
        jobs.map((job) => (job.jobId === next.jobId ? next : job)),
      );
      setDetail(next);
    });

  const cancelItem = (itemId: string) =>
    void run(async () => {
      const next = await api.cancelBatchJobItem(project.handle, itemId);
      onJobsChange(
        jobs.map((job) => (job.jobId === next.jobId ? next : job)),
      );
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
            全部
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
      <div className="task-list">
        {!visible.length && <p className="muted">{ui.batch.emptyJobs}</p>}
        {visible.map((job) => (
          <article key={job.jobId} className="task-card">
            <div className="task-card-main">
              <button
                type="button"
                className="task-name"
                onClick={() => setDetail(job)}
              >
                <strong>{job.name}</strong>
                <small>
                  {ui.batch.type(job.jobType)} · {ui.generation.status(job.status)} ·{" "}
                  {ui.batch.progress(job.itemCompleted, job.itemTotal)}
                </small>
              </button>
              <div className="task-meta">
                <span>
                  {ui.batch.scheduledAt}：{formatTime(job.scheduledAt)}
                </span>
                <span>
                  {ui.batch.document}：{job.document}
                </span>
              </div>
            </div>
            <div className="task-card-actions">
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
            </div>
          </article>
        ))}
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
            <div className="batch-shot-list">
              <div className="generation-section-title">
                <span>{ui.batch.items}</span>
                <small>{detail.items.length}</small>
              </div>
              {!detail.items.length && (
                <p className="muted">{ui.batch.noItems}</p>
              )}
              {detail.items.map((item) => (
                <div key={item.itemId} className="batch-shot-row task-item-row">
                  <div>
                    <code>{item.shotId}</code>
                    <span>{item.shotTitle || "—"}</span>
                    <small>
                      {ui.generation.status(item.status)}
                      {item.localFile ? ` · ${item.localFile}` : ""}
                    </small>
                    {item.error && (
                      <small className="generation-error">{item.error}</small>
                    )}
                    {item.status === "cancelled" && (
                      <small className="muted">{ui.batch.itemCancelled}</small>
                    )}
                  </div>
                  {item.status === "pending" && (
                    <button
                      type="button"
                      disabled={busy || acting}
                      onClick={() => cancelItem(item.itemId)}
                    >
                      {ui.batch.cancelItem}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="modal-actions">
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
    </main>
  );
}
