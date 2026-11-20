import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import { withMediaRevision } from "./mediaUrl";
import {
  generationPromptIssues,
  mediaKind,
  prepareGenerationSelection,
  regenerationSelections,
  shotAudioInputs,
  shotImageInputs,
  type InputAsset,
} from "./generationInputs";
import { Asset } from "./Preview";
import {
  canRetryGenerationDownload,
  retryGenerationDownload,
} from "./generationRetry";
import VideoPromptEditor from "./VideoPromptEditor";
import VideoPlayerModal from "./VideoPlayerModal";
import VideoTrimModal from "./VideoTrimModal";
import { ui } from "./i18n";
import {
  alignResolutionOption,
  optionsFromProfile,
  profileForVideoBinding,
  videoApiName,
  type VideoApiOptions,
} from "./videoWorkflows";
import type {
  ApiProfile,
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
        if (alive && media.path)
          setSrc(
            withMediaRevision(
              convertFileSrc(media.path),
              `${refreshKey}:${media.revision ?? ""}`,
            ),
          );
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
        <img key={src} src={src} alt="" />
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

interface GenerationReviewRequest {
  document: string;
  shotId: string;
  profileId: string;
  duration: number;
  resolution: string;
  seedOverride?: string;
  regeneration: boolean;
}

export default function GenerationPanel({
  card,
  episode,
  project,
  document,
  refreshKey,
  busy,
  defaultVideoApiProfileId,
  videoApiProfiles,
  videoWorkflow,
  configure,
  useVideo,
  renderField,
  savePrompt,
  promptReadonly,
  video,
  onMediaChanged,
}: {
  card: ShotCard;
  episode: EpisodeData;
  project: Project;
  document: string;
  refreshKey: number;
  busy: boolean;
  defaultVideoApiProfileId: string;
  videoApiProfiles: readonly ApiProfile[];
  videoWorkflow: VideoApiOptions;
  configure: () => void;
  useVideo: (reference: string) => Promise<void>;
  renderField: (key: BoardField, multiline?: boolean) => React.ReactNode;
  savePrompt: (value: string) => Promise<void>;
  promptReadonly: boolean;
  video: React.ReactNode;
  onMediaChanged?: (message: string) => void;
}) {
  const [seedOverride, setSeedOverride] = useState<string>();
  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [task, setTask] = useState<GenerationRecord | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GenerationRecord | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<InputAsset | null>(null);
  const [playingVideo, setPlayingVideo] = useState<GenerationRecord | null>(
    null,
  );
  const [trimmingVideo, setTrimmingVideo] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewBasePrompt, setReviewBasePrompt] = useState("");
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [reviewImageInputs, setReviewImageInputs] = useState<InputAsset[]>([]);
  const [reviewAudioInputs, setReviewAudioInputs] = useState<InputAsset[]>([]);
  const [reviewImages, setReviewImages] = useState<boolean[]>([]);
  const [reviewAudios, setReviewAudios] = useState<boolean[]>([]);
  const [reviewRequest, setReviewRequest] =
    useState<GenerationReviewRequest | null>(null);
  const applied = useRef(new Set<string>());
  const useVideoRef = useRef(useVideo);
  useVideoRef.current = useVideo;

  useEffect(() => {
    setSeedOverride(undefined);
  }, [videoWorkflow.defaultSeed]);

  useEffect(() => {
    setReviewOpen(false);
    setDeleteTarget(null);
  }, [card.id, document]);

  const imageInputs = useMemo(
    () => shotImageInputs(card, episode, videoWorkflow.maxImages),
    [card, episode, videoWorkflow.maxImages],
  );
  const audioInputs = useMemo(
    () => shotAudioInputs(card, episode),
    [card, episode],
  );
  const reviewApiChoices = useMemo(
    () =>
      videoApiProfiles.map((profile) => {
        const options = optionsFromProfile(profile);
        const ready =
          profile.hasAuthorization &&
          Boolean(profile.submitUrl.trim()) &&
          Boolean(profile.queryUrl.trim()) &&
          options.resolutions.length > 0;
        return { profile, options, ready };
      }),
    [videoApiProfiles],
  );
  const reviewApi = reviewApiChoices.find(
    ({ profile, ready }) => ready && profile.id === reviewRequest?.profileId,
  );
  const reviewResolutions = reviewApi?.options.resolutions ?? [];
  const reviewResolution =
    alignResolutionOption(reviewRequest?.resolution ?? "", reviewResolutions) ??
    "";
  const reviewSeed =
    reviewRequest?.seedOverride ?? reviewApi?.options.defaultSeed ?? "";
  const selectedImageCount = reviewImages.filter(Boolean).length;
  const selectedAudioCount = reviewAudios.filter(Boolean).length;
  const reviewIssues = useMemo(
    () =>
      generationPromptIssues(
        reviewPrompt,
        selectedImageCount,
        selectedAudioCount,
      ),
    [reviewPrompt, selectedImageCount, selectedAudioCount],
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
            await useVideoRef.current(next.localFile);
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
  }, [task, project.handle]);

  const openReview = (
    prompt: string,
    reviewImageAssets: InputAsset[],
    reviewAudioAssets: InputAsset[],
    request: Omit<GenerationReviewRequest, "profileId">,
    images = reviewImageAssets.map(() => true),
    audios = reviewAudioAssets.map(() => true),
    preservePrompt = false,
  ) => {
    if (!reviewApiChoices.some(({ ready }) => ready)) {
      configure();
      return;
    }
    const defaultApi = reviewApiChoices.find(
      ({ profile, ready }) => ready && profile.id === defaultVideoApiProfileId,
    );
    const prepared = prepareGenerationSelection(
      prompt,
      reviewImageAssets,
      reviewAudioAssets,
      images,
      audios,
    );
    setReviewBasePrompt(prompt);
    setReviewImageInputs(reviewImageAssets);
    setReviewAudioInputs(reviewAudioAssets);
    setReviewImages(images);
    setReviewAudios(audios);
    setReviewPrompt(preservePrompt ? prompt : prepared.prompt);
    setReviewRequest({ ...request, profileId: defaultApi?.profile.id ?? "" });
    setError("");
    setReviewOpen(true);
  };

  const openSubmissionReview = () => {
    openReview(card.fields.videoPrompt.value, imageInputs, audioInputs, {
      document,
      shotId: card.id,
      duration: Number(card.fields.duration.value || "5"),
      resolution:
        card.fields.resolution.value.trim() || videoWorkflow.defaultResolution,
      seedOverride,
      regeneration: false,
    });
  };

  const openRegenerationReview = (record: GenerationRecord) => {
    const selected = regenerationSelections(imageInputs, audioInputs, record);
    openReview(
      record.prompt,
      imageInputs,
      audioInputs,
      {
        document: record.document,
        shotId: record.shotId,
        duration: record.duration,
        resolution: record.resolution,
        seedOverride: record.seed === null ? "" : String(record.seed),
        regeneration: true,
      },
      selected.images,
      selected.audios,
      true,
    );
  };

  const rebuildReviewPrompt = (images: boolean[], audios: boolean[]) => {
    setReviewPrompt(
      prepareGenerationSelection(
        reviewBasePrompt,
        reviewImageInputs,
        reviewAudioInputs,
        images,
        audios,
      ).prompt,
    );
  };

  const setReviewImage = (index: number, selected: boolean) => {
    if (index === 0) return;
    const next = reviewImages.map((value, current) =>
      current === index ? selected : value,
    );
    setReviewImages(next);
    rebuildReviewPrompt(next, reviewAudios);
  };

  const setReviewAudio = (index: number, selected: boolean) => {
    const next = reviewAudios.map((value, current) =>
      current === index ? selected : value,
    );
    setReviewAudios(next);
    rebuildReviewPrompt(reviewImages, next);
  };

  const submit = async () => {
    if (!reviewRequest || !reviewApi || !reviewResolution) return;
    setSubmitting(true);
    setError("");
    try {
      const { duration } = reviewRequest;
      const submittedSeed = reviewSeed ? Number(reviewSeed) : null;
      if (!Number.isInteger(duration) || duration < 1 || duration > 15)
        throw new Error(ui.generation.invalidDuration);
      if (submittedSeed !== null && !Number.isSafeInteger(submittedSeed))
        throw new Error(ui.generation.invalidSeed);
      const next = await api.submitGeneration(
        project.handle,
        reviewApi.profile.id,
        {
          document: reviewRequest.document,
          shotId: reviewRequest.shotId,
          prompt: reviewPrompt,
          duration,
          resolution: reviewResolution,
          seed: submittedSeed,
          imageRefs: reviewImageInputs
            .filter((_, index) => reviewImages[index] !== false)
            .map((item) => item.reference),
          audioRefs: reviewAudioInputs
            .filter((_, index) => reviewAudios[index] !== false)
            .map((item) => item.reference),
        },
      );
      setReviewOpen(false);
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

  const retryDownload = async (record: GenerationRecord) => {
    setRetryingTaskId(record.taskId);
    setError("");
    try {
      const next = await retryGenerationDownload(record.taskId, (taskId) =>
        api.pollGeneration(project.handle, taskId),
      );
      setTask(next);
      setHistory((items) => [
        next,
        ...items.filter((item) => item.taskId !== next.taskId),
      ]);
      applied.current.add(next.taskId);
      await useVideo(next.localFile);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRetryingTaskId(null);
    }
  };

  const deleteVersion = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await api.deleteGeneration(
        project.handle,
        document,
        card.id,
        deleteTarget.taskId,
      );
      setHistory((items) =>
        items.filter((item) => item.taskId !== deleteTarget.taskId),
      );
      setTask((current) =>
        current?.taskId === deleteTarget.taskId ? null : current,
      );
      applied.current.delete(deleteTarget.taskId);
      setDeleteTarget(null);
      onMediaChanged?.(ui.generation.versionDeleted);
    } catch (e) {
      setError(errorMessage(e));
      // A filesystem cleanup error can occur after the record was removed.
      await loadHistory().catch(() => undefined);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="shot-main generation-panel">
      <div className="shot-narrative">
        <div className="generation-fields">
          <VideoPromptEditor
            key={`${project.handle}:${document}:${card.id}`}
            value={card.fields.videoPrompt.value}
            disabled={
              busy || promptReadonly || Boolean(card.fields.videoPrompt.ambiguous)
            }
            save={savePrompt}
          />
          <div className="generation-parameters">
            {renderField("duration")}
            {renderField("resolution")}
            <label className="board-field">
              <span>{ui.generation.seed}</span>
              <input
                inputMode="numeric"
                value={seedOverride ?? videoWorkflow.defaultSeed}
                placeholder={ui.generation.randomSeed}
                onChange={(event) =>
                  setSeedOverride(event.target.value.replace(/[^0-9]/g, ""))
                }
              />
            </label>
          </div>
        </div>
      </div>
      <div className="generation-media">
        {trimmingVideo ? (
          <div className="shot-media">
            <div className="video-placeholder">{ui.generation.trimming}</div>
          </div>
        ) : (
          video
        )}
        <div className="generation-assets">
          <div className="generation-section-title">
            <span>{ui.generation.referenceImages}</span>
            <small>
              {imageInputs.length}/{videoWorkflow.maxImages}
            </small>
          </div>
          <div className="generation-thumbs">
            {imageInputs.map((item, index) => (
              <div
                className="generation-thumb-wrap"
                key={`${index}-${item.reference}`}
              >
                <Thumbnail
                  project={project}
                  document={document}
                  item={{ ...item, label: `图 ${index + 1}` }}
                  refreshKey={refreshKey}
                  onOpen={() => setPreview(item)}
                />
              </div>
            ))}
            {!imageInputs.length && <p className="muted">{ui.board.noFrame}</p>}
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
          <div className="generation-submit-status">
            <strong>
              {task && running(task.status)
                ? ui.generation.generating
                : ui.board.generate}
            </strong>
            <small>
              {task ? ui.generation.status(task.status) : ui.generation.ready}
            </small>
          </div>
          {task && (
            <div className="generation-submit-meta">
              <small>
                <span>{ui.generation.taskId}：</span>
                <span title={task.taskId}>{task.taskId}</span>
              </small>
              <small>
                <span>{ui.generation.createdAt}：</span>
                <span>{new Date(task.createdAt).toLocaleString("zh-CN")}</span>
              </small>
            </div>
          )}
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
            onClick={openSubmissionReview}
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
                  <div className="generation-history-actions">
                    {canRetryGenerationDownload(record) && (
                      <button
                        type="button"
                        disabled={
                          busy ||
                          submitting ||
                          retryingTaskId !== null ||
                          !!(task && running(task.status))
                        }
                        onClick={() => void retryDownload(record)}
                      >
                        {retryingTaskId === record.taskId
                          ? ui.generation.retryingDownload
                          : ui.generation.retryDownload}
                      </button>
                    )}
                    {record.localFile && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPlayingVideo(record)}
                      >
                        {ui.generation.play}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={
                        busy ||
                        submitting ||
                        !!(task && running(task.status)) ||
                        !record.prompt.trim()
                      }
                      onClick={() => openRegenerationReview(record)}
                    >
                      {ui.generation.regeneration}
                    </button>
                    {record.localFile && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setPlayingVideo(null);
                            setTrimmingVideo(record.localFile!);
                          }}
                        >
                          {ui.generation.edit}
                        </button>
                        <button
                          type="button"
                          disabled={
                            busy ||
                            record.localFile === card.fields.videoFile.value
                          }
                          onClick={() => void useVideo(record.localFile!)}
                        >
                          {record.localFile === card.fields.videoFile.value
                            ? ui.generation.inUse
                            : ui.generation.useVersion}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="danger-button"
                      disabled={
                        busy ||
                        submitting ||
                        deleting ||
                        retryingTaskId !== null ||
                        !!trimmingVideo ||
                        !!playingVideo ||
                        running(record.status) ||
                        !!(
                          record.localFile &&
                          record.localFile === card.fields.videoFile.value
                        )
                      }
                      title={
                        record.localFile &&
                        record.localFile === card.fields.videoFile.value
                          ? ui.generation.deleteCurrentHint
                          : ui.generation.deleteVersionTitle
                      }
                      onClick={() => {
                        setError("");
                        setDeleteTarget(record);
                      }}
                    >
                      {ui.generation.deleteVersion}
                    </button>
                  </div>
                  <small className="generation-history-meta">
                    <span>
                      {ui.generation.submitApi}：
                      {videoApiName(
                        record.provider?.submitUrl,
                        profileForVideoBinding(videoApiProfiles, record.provider),
                      ) || ui.generation.unknownApi}
                    </span>
                    <span>
                      {ui.generation.taskId}：{record.taskId}
                    </span>
                  </small>
                </article>
              ))}
            </div>
          </details>
        )}
      </div>
      {trimmingVideo && (
        <VideoTrimModal
          project={project}
          document={document}
          reference={trimmingVideo}
          refreshKey={refreshKey}
          onClose={() => setTrimmingVideo(null)}
          onSaved={() => {
            setTrimmingVideo(null);
            onMediaChanged?.(ui.generation.videoTrimmed);
          }}
        />
      )}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        >
          <section
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`generation-delete-${card.id}`}
            aria-describedby={`generation-delete-hint-${card.id}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id={`generation-delete-${card.id}`}>
              {ui.generation.deleteVersionTitle}
            </h2>
            <p id={`generation-delete-hint-${card.id}`}>
              {ui.generation.deleteVersionHint}
            </p>
            <p>{new Date(deleteTarget.createdAt).toLocaleString("zh-CN")}</p>
            {deleteTarget.localFile && <p>{deleteTarget.localFile}</p>}
            {error && (
              <p className="generation-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                autoFocus
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                {ui.cancel}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={
                  deleting ||
                  busy ||
                  submitting ||
                  retryingTaskId !== null ||
                  !!(
                    deleteTarget.localFile &&
                    deleteTarget.localFile === card.fields.videoFile.value
                  )
                }
                onClick={() => void deleteVersion()}
              >
                {deleting
                  ? ui.generation.deletingVersion
                  : ui.generation.confirmDeleteVersion}
              </button>
            </div>
          </section>
        </div>
      )}
      {playingVideo && (
        <VideoPlayerModal
          project={project}
          document={document}
          reference={playingVideo.localFile!}
          title={playingVideo.localFile!.replace(/.*[/\\]/, "")}
          refreshKey={refreshKey}
          generation={playingVideo}
          onClose={() => setPlayingVideo(null)}
        />
      )}
      {reviewOpen && reviewRequest && (
        <div
          className="modal-backdrop generation-submit-backdrop"
          onMouseDown={() => {
            if (!submitting) setReviewOpen(false);
          }}
        >
          <section
            className="modal generation-submit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`generation-submit-${card.id}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              aria-label={ui.cancel}
              disabled={submitting}
              onClick={() => setReviewOpen(false)}
            >
              ×
            </button>
            <h2 id={`generation-submit-${card.id}`}>
              {reviewRequest.regeneration
                ? ui.generation.regenerationReviewTitle
                : ui.generation.reviewTitle}
            </h2>
            <p className="generation-review-hint">
              {reviewRequest.regeneration
                ? ui.generation.regenerationReviewHint
                : ui.generation.reviewHint}
            </p>
            <div className="generation-review-parameters">
              <label className="generation-review-api">
                <span>{ui.generation.reviewApi}</span>
                <select
                  value={reviewApi?.profile.id ?? ""}
                  disabled={submitting}
                  onChange={(event) => {
                    const profileId = event.target.value;
                    setReviewRequest((current) =>
                      current ? { ...current, profileId } : current,
                    );
                    setError("");
                  }}
                >
                  <option value="" disabled>
                    {ui.generation.chooseReviewApi}
                  </option>
                  {reviewApiChoices.map(({ profile, ready }) => (
                    <option
                      key={profile.id}
                      value={profile.id}
                      disabled={!ready}
                    >
                      {ready
                        ? profile.name
                        : ui.generation.unavailableReviewApi(profile.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{ui.board.duration}</span>
                <select
                  value={String(reviewRequest.duration)}
                  disabled={submitting}
                  onChange={(event) =>
                    setReviewRequest((current) =>
                      current
                        ? { ...current, duration: Number(event.target.value) }
                        : current,
                    )
                  }
                >
                  {Array.from({ length: 15 }, (_, index) => index + 1).map(
                    (value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                <span>{ui.board.resolution}</span>
                <select
                  value={reviewResolution}
                  disabled={submitting || !reviewApi}
                  onChange={(event) => {
                    const resolution = event.target.value;
                    setReviewRequest((current) =>
                      current ? { ...current, resolution } : current,
                    );
                  }}
                >
                  <option value="" disabled>
                    {ui.generation.chooseReviewResolution}
                  </option>
                  {reviewResolutions.map((resolution) => (
                    <option key={resolution} value={resolution}>
                      {resolution}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{ui.generation.seed}</span>
                <input
                  inputMode="numeric"
                  value={reviewSeed}
                  placeholder={ui.generation.randomSeed}
                  disabled={submitting}
                  onChange={(event) => {
                    const value = event.target.value.replace(/[^0-9]/g, "");
                    setReviewRequest((current) =>
                      current ? { ...current, seedOverride: value } : current,
                    );
                  }}
                />
              </label>
            </div>
            <div className="generation-review-layout">
              <div className="generation-review-assets">
                <div className="generation-review-heading">
                  <strong>{ui.generation.referenceImages}</strong>
                  <span>
                    {selectedImageCount}/{reviewImageInputs.length}
                  </span>
                </div>
                <div className="generation-review-list">
                  {reviewImageInputs.map((item, index) => {
                    const selected = reviewImages[index] !== false;
                    const nextSlot = reviewImages
                      .slice(0, index + 1)
                      .filter(Boolean).length;
                    return (
                      <div
                        className={`generation-review-asset${selected ? " selected" : ""}`}
                        key={`review-image-${index}-${item.reference}`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${ui.generation.referenceImages} ${index + 1}`}
                          checked={selected}
                          disabled={index === 0 || submitting}
                          onChange={(event) =>
                            setReviewImage(index, event.target.checked)
                          }
                        />
                        <Thumbnail
                          project={project}
                          document={document}
                          item={{ ...item, label: `图 ${index + 1}` }}
                          refreshKey={refreshKey}
                          onOpen={() => setPreview(item)}
                        />
                        <div>
                          <strong>
                            {item.reference.replace(/.*[/\\]/, "")}
                          </strong>
                          <small>
                            {index === 0
                              ? ui.generation.firstFrameLocked
                              : selected
                                ? ui.generation.renumberedPicture(
                                    index + 1,
                                    nextSlot,
                                  )
                                : ui.generation.notSubmitted}
                          </small>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!!reviewAudioInputs.length && (
                  <>
                    <div className="generation-review-heading audio-title">
                      <strong>{ui.generation.referenceAudios}</strong>
                      <span>
                        {selectedAudioCount}/{reviewAudioInputs.length}
                      </span>
                    </div>
                    <div className="generation-review-list">
                      {reviewAudioInputs.map((item, index) => {
                        const selected = reviewAudios[index] !== false;
                        const nextSlot = reviewAudios
                          .slice(0, index + 1)
                          .filter(Boolean).length;
                        return (
                          <div
                            className={`generation-review-asset${selected ? " selected" : ""}`}
                            key={`review-audio-${index}-${item.reference}`}
                          >
                            <input
                              type="checkbox"
                              aria-label={`${ui.generation.referenceAudios} ${index + 1}`}
                              checked={selected}
                              disabled={submitting}
                              onChange={(event) =>
                                setReviewAudio(index, event.target.checked)
                              }
                            />
                            <Thumbnail
                              project={project}
                              document={document}
                              item={{ ...item, label: `音 ${index + 1}` }}
                              refreshKey={refreshKey}
                              onOpen={() => setPreview(item)}
                            />
                            <div>
                              <strong>
                                {item.reference.replace(/.*[/\\]/, "")}
                              </strong>
                              <small>
                                {selected
                                  ? ui.generation.renumberedAudio(
                                      index + 1,
                                      nextSlot,
                                    )
                                  : ui.generation.notSubmitted}
                              </small>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <div className="generation-review-prompt">
                <label htmlFor={`generation-review-prompt-${card.id}`}>
                  {ui.generation.submittedPrompt}
                </label>
                <textarea
                  id={`generation-review-prompt-${card.id}`}
                  value={reviewPrompt}
                  disabled={submitting}
                  spellCheck={false}
                  onChange={(event) => setReviewPrompt(event.target.value)}
                />
                {!!reviewIssues.length && (
                  <div className="generation-review-warnings" role="alert">
                    {reviewIssues.map((issue) => (
                      <p key={`${issue.kind}-${issue.tag}`}>
                        {issue.kind === "cancelled-reference"
                          ? ui.generation.cancelledReference(issue.tag)
                          : ui.generation.missingReference(issue.tag)}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {error && (
              <p className="generation-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setReviewOpen(false)}
              >
                {ui.cancel}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  submitting ||
                  !reviewApi ||
                  !reviewResolution ||
                  !reviewPrompt.trim() ||
                  selectedImageCount < 1 ||
                  reviewIssues.length > 0
                }
                onClick={() => void submit()}
              >
                {submitting
                  ? ui.generation.submitting
                  : ui.generation.confirmSubmit}
              </button>
            </div>
          </section>
        </div>
      )}
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
              compact
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
