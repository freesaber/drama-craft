import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import {
  mediaKind,
  shotAudioInputs,
  shotImageInputs,
  type InputAsset,
} from "./generationInputs";
import { Asset } from "./Preview";
import { ui } from "./i18n";
import type {
  BoardField,
  EpisodeData,
  GenerationRecord,
  Project,
  ShotCard,
} from "./types";

function Thumbnail({
  project,
  document,
  item,
  refreshKey,
  onOpen,
}: {
  project: Project;
  document: string;
  item: InputAsset;
  refreshKey: number;
  onOpen: () => void;
}) {
  const [src, setSrc] = useState("");
  const kind = mediaKind(item.reference);
  useEffect(() => {
    let alive = true;
    setSrc("");
    void api
      .media(project.handle, document, item.reference)
      .then((media) => {
        if (alive && media.path) setSrc(convertFileSrc(media.path));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [project.handle, document, item.reference, refreshKey]);
  return (
    <button
      type="button"
      className="generation-thumb"
      title={`${item.label}：${item.reference}`}
      onClick={onOpen}
    >
      {src && kind === "image" ? (
        <img src={src} alt="" />
      ) : (
        <span>{kind === "audio" ? "♫" : "▧"}</span>
      )}
      <small>{item.label}</small>
    </button>
  );
}

const running = (status: string) =>
  ![
    "completed",
    "success",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "download_failed",
  ].includes(status.toLowerCase());

export default function GenerationPanel({
  card,
  episode,
  project,
  document,
  refreshKey,
  busy,
  configured,
  configure,
  useVideo,
  renderField,
  video,
}: {
  card: ShotCard;
  episode: EpisodeData;
  project: Project;
  document: string;
  refreshKey: number;
  busy: boolean;
  configured: boolean;
  configure: () => void;
  useVideo: (reference: string) => Promise<void>;
  renderField: (key: BoardField, multiline?: boolean) => React.ReactNode;
  video: React.ReactNode;
}) {
  const [seed, setSeed] = useState("683072603085674");
  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [task, setTask] = useState<GenerationRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<InputAsset | null>(null);
  const applied = useRef(new Set<string>());

  const imageInputs = useMemo(
    () => shotImageInputs(card, episode),
    [card, episode],
  );
  const audioInputs = useMemo(
    () => shotAudioInputs(card, episode),
    [card, episode],
  );

  const loadHistory = async () => {
    const records = await api.generationHistory(
      project.handle,
      document,
      card.id,
    );
    setHistory(records);
    const active = records.find((record) => running(record.status));
    if (active) setTask(active);
  };
  useEffect(() => {
    void loadHistory().catch((e) => setError(errorMessage(e)));
  }, [project.handle, document, card.id]);

  useEffect(() => {
    if (!task || !running(task.status)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .pollGeneration(project.handle, task.taskId)
        .then(async (next) => {
          if (cancelled) return;
          setTask(next);
          setHistory((items) => [
            next,
            ...items.filter((item) => item.taskId !== next.taskId),
          ]);
          setError(next.error ?? "");
          if (next.localFile && !applied.current.has(next.taskId)) {
            applied.current.add(next.taskId);
            await useVideo(next.localFile);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(errorMessage(e));
            setTask((current) => (current ? { ...current } : current));
          }
        });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [task, project.handle, useVideo]);

  const submit = async () => {
    if (!configured) {
      configure();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const duration = Number(card.fields.duration.value || "5");
      const parsedSeed = seed.trim() ? Number(seed) : null;
      if (!Number.isInteger(duration) || duration < 1 || duration > 15)
        throw new Error(ui.generation.invalidDuration);
      if (seed.trim() && !Number.isSafeInteger(parsedSeed))
        throw new Error(ui.generation.invalidSeed);
      const next = await api.submitGeneration(project.handle, {
        document,
        shotId: card.id,
        prompt: card.fields.videoPrompt.value,
        duration,
        resolution: card.fields.resolution.value || "768p竖",
        seed: parsedSeed,
        imageRefs: imageInputs.map((item) => item.reference),
        audioRefs: audioInputs.map((item) => item.reference),
      });
      setTask(next);
      setHistory((items) => [
        next,
        ...items.filter((item) => item.taskId !== next.taskId),
      ]);
      if (next.localFile) {
        applied.current.add(next.taskId);
        await useVideo(next.localFile);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="shot-main generation-panel">
      <div className="shot-narrative">
        <div className="generation-fields">
          {renderField("videoPrompt", true)}
          <div className="generation-parameters">
            {renderField("duration")}
            {renderField("resolution")}
            <label className="board-field">
              <span>{ui.generation.seed}</span>
              <input
                inputMode="numeric"
                value={seed}
                placeholder={ui.generation.randomSeed}
                onChange={(event) =>
                  setSeed(event.target.value.replace(/[^0-9]/g, ""))
                }
              />
            </label>
          </div>
        </div>
      </div>
      <div className="generation-media">
        {video}
        <div className="generation-assets">
          <div className="generation-section-title">
            <span>{ui.generation.referenceImages}</span>
            <small>{imageInputs.length}/9</small>
          </div>
          <div className="generation-thumbs">
            {imageInputs.map((item, index) => (
              <div className="generation-thumb-wrap" key={`${index}-${item.reference}`}>
                <Thumbnail
                  project={project}
                  document={document}
                  item={{ ...item, label: `图 ${index + 1}` }}
                  refreshKey={refreshKey}
                  onOpen={() => setPreview(item)}
                />
              </div>
            ))}
            {!imageInputs.length && (
              <p className="muted">{ui.board.noFrame}</p>
            )}
          </div>
          {!!audioInputs.length && (
            <>
              <div className="generation-section-title audio-title">
                <span>{ui.generation.referenceAudios}</span>
                <small>{audioInputs.length}/3</small>
              </div>
              <div className="generation-thumbs">
                {audioInputs.map((item, index) => (
                  <div
                    className="generation-thumb-wrap"
                    key={`${index}-${item.reference}`}
                  >
                    <Thumbnail
                      project={project}
                      document={document}
                      item={item}
                      refreshKey={refreshKey}
                      onOpen={() => setPreview(item)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="generation-actions">
        <div className="generation-submit">
          <div>
            <strong>
              {task && running(task.status)
                ? ui.generation.generating
                : ui.board.generate}
            </strong>
            <small>
              {task ? ui.generation.status(task.status) : ui.generation.ready}
            </small>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={
              busy ||
              submitting ||
              !!(task && running(task.status)) ||
              !card.fields.videoPrompt.value.trim() ||
              !imageInputs.length
            }
            onClick={() => void submit()}
          >
            {submitting ? ui.generation.submitting : ui.board.generate}
          </button>
        </div>
        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}
        {!!history.length && (
          <details className="generation-history">
            <summary>
              {ui.generation.history} <span>{history.length}</span>
            </summary>
            <div>
              {history.map((record) => (
                <article
                  key={record.taskId}
                  className={
                    record.localFile === card.fields.videoFile.value
                      ? "current"
                      : ""
                  }
                >
                  <div>
                    <strong>
                      {new Date(record.createdAt).toLocaleString("zh-CN")}
                    </strong>
                    <small>
                      {record.duration} 秒 · {record.resolution} ·{" "}
                      {ui.generation.status(record.status)}
                    </small>
                    {record.error && (
                      <small className="generation-error">{record.error}</small>
                    )}
                  </div>
                  {record.localFile && (
                    <button
                      type="button"
                      disabled={
                        busy || record.localFile === card.fields.videoFile.value
                      }
                      onClick={() => void useVideo(record.localFile!)}
                    >
                      {record.localFile === card.fields.videoFile.value
                        ? ui.generation.inUse
                        : ui.generation.useVersion}
                    </button>
                  )}
                </article>
              ))}
            </div>
          </details>
        )}
      </div>
      {preview && (
        <div
          className="modal-backdrop generation-preview"
          onMouseDown={() => setPreview(null)}
        >
          <section
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>
              {preview.label} · {preview.reference}
            </h2>
            <Asset
              project={project}
              document={document}
              reference={preview.reference}
              refreshKey={refreshKey}
              hero
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setPreview(null)}>
                {ui.confirm}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
