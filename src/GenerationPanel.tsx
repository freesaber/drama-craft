import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, chooseMedia, errorMessage } from "./api";
import { Asset } from "./Preview";
import { fieldPatch } from "./storyboard";
import { ui } from "./i18n";
import type {
  BoardField,
  EpisodeData,
  GenerationRecord,
  Project,
  ShotCard,
  SourceField,
  SourcePatch,
  Storyboard,
} from "./types";

type InputAsset = { reference: string; field?: SourceField; label: string };

function mediaKind(reference: string): "image" | "audio" | "video" | null {
  const clean = reference.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(clean)) return "image";
  if (/\.(mp3|wav|flac)$/.test(clean)) return "audio";
  if (/\.mp4$/.test(clean)) return "video";
  return null;
}

function unique(items: InputAsset[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.reference || seen.has(item.reference)) return false;
    seen.add(item.reference);
    return true;
  });
}

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
  board,
  episode,
  project,
  document,
  refreshKey,
  busy,
  configured,
  configure,
  apply,
  useVideo,
  renderField,
}: {
  card: ShotCard;
  board: Storyboard;
  episode: EpisodeData;
  project: Project;
  document: string;
  refreshKey: number;
  busy: boolean;
  configured: boolean;
  configure: () => void;
  apply: (patch: SourcePatch) => boolean;
  useVideo: (reference: string) => Promise<void>;
  renderField: (key: BoardField, multiline?: boolean) => React.ReactNode;
}) {
  const [seed, setSeed] = useState("");
  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [task, setTask] = useState<GenerationRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<InputAsset | null>(null);
  const [imageOverrides, setImageOverrides] = useState<Record<number, string>>(
    {},
  );
  const [audioOverrides, setAudioOverrides] = useState<Record<number, string>>(
    {},
  );
  const [extraImages, setExtraImages] = useState<string[]>([]);
  const applied = useRef(new Set<string>());

  const cast = new Set(episode.castByShot[card.id] ?? []);
  const imageInputs = useMemo(() => {
    const items: InputAsset[] = [];
    const frame = card.fields.frameFile.value.trim();
    if (frame)
      items.push({
        reference: frame,
        field: card.fields.frameFile,
        label: "首帧",
      });
    for (const role of episode.characters)
      if (cast.has(role.id) && role.image)
        items.push({ reference: role.image, label: role.name });
    for (const asset of episode.assets)
      if (
        asset.reference &&
        asset.shots.includes(card.id) &&
        mediaKind(asset.reference) === "image"
      )
        items.push({ reference: asset.reference, label: asset.name });
    for (const entry of card.references)
      if (mediaKind(entry.reference) === "image")
        items.push({
          reference: entry.reference,
          field: entry.field,
          label: "素材",
        });
    return unique(items).slice(0, 9);
  }, [card, episode]);
  const audioInputs = useMemo(() => {
    const items: InputAsset[] = [];
    for (const role of episode.characters)
      if (cast.has(role.id) && role.voice)
        items.push({ reference: role.voice, label: role.name });
    for (const entry of card.references)
      if (mediaKind(entry.reference) === "audio")
        items.push({
          reference: entry.reference,
          field: entry.field,
          label: "声音",
        });
    return unique(items).slice(0, 3);
  }, [card, episode]);
  const effectiveImages = [
    ...imageInputs.map(
      (item, index) => imageOverrides[index] ?? item.reference,
    ),
    ...extraImages,
  ].slice(0, 9);
  const effectiveAudios = audioInputs.map(
    (item, index) => audioOverrides[index] ?? item.reference,
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

  const replace = async (
    kind: "image" | "audio",
    index: number,
    item?: InputAsset,
  ) => {
    try {
      const selected = await chooseMedia(kind);
      if (!selected) return;
      const reference = await api.importGenerationMedia(
        project.handle,
        document,
        selected,
        card.id,
        `${kind}_${index}`,
      );
      if (item?.field && !apply(fieldPatch(board, item.field, reference)))
        return;
      if (kind === "image") {
        if (item)
          setImageOverrides((value) => ({ ...value, [index]: reference }));
        else
          setExtraImages((value) =>
            [...value, reference].slice(0, 9 - imageInputs.length),
          );
      } else setAudioOverrides((value) => ({ ...value, [index]: reference }));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const submit = async () => {
    if (!configured) {
      configure();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const duration = Number.parseInt(card.fields.duration.value || "5", 10);
      const parsedSeed = seed.trim() ? Number.parseInt(seed, 10) : null;
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
        imageRefs: effectiveImages,
        audioRefs: effectiveAudios,
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
    <section className="generation-panel">
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
      <div className="generation-assets">
        <div className="generation-section-title">
          <span>{ui.generation.referenceImages}</span>
          <small>{effectiveImages.length}/9</small>
        </div>
        <div className="generation-thumbs">
          {imageInputs.map((item, index) => {
            const current = {
              ...item,
              reference: imageOverrides[index] ?? item.reference,
            };
            return (
              <div
                className="generation-thumb-wrap"
                key={`${index}-${current.reference}`}
              >
                <Thumbnail
                  project={project}
                  document={document}
                  item={{ ...current, label: `图 ${index + 1}` }}
                  refreshKey={refreshKey}
                  onOpen={() => setPreview(current)}
                />
                <button
                  type="button"
                  onClick={() => void replace("image", index, item)}
                >
                  {ui.generation.replace}
                </button>
              </div>
            );
          })}
          {extraImages.map((reference, extraIndex) => (
            <div className="generation-thumb-wrap" key={reference}>
              <Thumbnail
                project={project}
                document={document}
                item={{
                  reference,
                  label: `图 ${imageInputs.length + extraIndex + 1}`,
                }}
                refreshKey={refreshKey}
                onOpen={() => setPreview({ reference, label: "本次添加" })}
              />
            </div>
          ))}
          {effectiveImages.length < 9 && (
            <button
              className="generation-add-asset"
              type="button"
              onClick={() => void replace("image", effectiveImages.length)}
            >
              ＋<small>{ui.generation.addImage}</small>
            </button>
          )}
        </div>
        {!!audioInputs.length && (
          <>
            <div className="generation-section-title audio-title">
              <span>{ui.generation.referenceAudios}</span>
              <small>{effectiveAudios.length}/3</small>
            </div>
            <div className="generation-thumbs">
              {audioInputs.map((item, index) => {
                const current = {
                  ...item,
                  reference: audioOverrides[index] ?? item.reference,
                };
                return (
                  <div
                    className="generation-thumb-wrap"
                    key={`${index}-${current.reference}`}
                  >
                    <Thumbnail
                      project={project}
                      document={document}
                      item={current}
                      refreshKey={refreshKey}
                      onOpen={() => setPreview(current)}
                    />
                    <button
                      type="button"
                      onClick={() => void replace("audio", index, item)}
                    >
                      {ui.generation.replace}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
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
            !effectiveImages.length
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
      {preview && (
        <div
          className="modal-backdrop generation-preview"
          onClick={() => setPreview(null)}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setPreview(null)}>
              ×
            </button>
            <Asset
              project={project}
              document={document}
              reference={preview.reference}
              refreshKey={refreshKey}
              hero
            />
          </section>
        </div>
      )}
    </section>
  );
}
