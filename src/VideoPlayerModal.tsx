import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import { withMediaRevision } from "./mediaUrl";
import type { Project } from "./types";

interface ReplayGeneration {
  prompt: string;
  duration: number;
  resolution: string;
  seed: number | null;
  taskId?: string | null;
  createdAt?: string | null;
}

function formatCreatedAt(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export default function VideoPlayerModal({
  project,
  document,
  reference,
  title,
  expectedKind = "video",
  refreshKey = 0,
  generation,
  onClose,
}: {
  project: Project;
  document: string;
  reference: string;
  title?: string;
  expectedKind?: "video" | "audio";
  refreshKey?: number;
  generation?: ReplayGeneration;
  onClose: () => void;
}) {
  const [src, setSrc] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSrc("");
    setMissing(false);
    setError("");
    setFailed(false);
    void api
      .media(project.handle, document, reference)
      .then((media) => {
        if (!active) return;
        if (!media.exists || !media.path) {
          setMissing(true);
          return;
        }
        if (media.kind !== expectedKind) {
          setError(
            expectedKind === "audio"
              ? ui.audioPlayer.notAudio
              : ui.videoPlayer.notVideo,
          );
          return;
        }
        setSrc(
          withMediaRevision(
            convertFileSrc(media.path),
            `${refreshKey}:${media.revision ?? ""}`,
          ),
        );
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [project.handle, document, reference, refreshKey, expectedKind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label = title ?? reference.replace(/.*[/\\]/, "");

  return (
    <div className="modal-backdrop video-player-backdrop" onMouseDown={onClose}>
      <section
        className="modal video-player-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-player-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={ui.cancel}
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="video-player-title">{label}</h2>
        {generation ? (
          <p className="muted video-player-reference">
            {ui.generation.taskId}：{generation.taskId || "—"} ·{" "}
            {ui.generation.createdAt}：{formatCreatedAt(generation.createdAt)}
          </p>
        ) : (
          <p className="muted video-player-reference" title={reference}>
            {reference}
          </p>
        )}
        {generation && (
          <section className="video-player-prompt">
            <div className="video-player-prompt-heading">
              <strong>{ui.generation.submittedPrompt}</strong>
              <small>
                {generation.duration} 秒 · {generation.resolution}
                {generation.seed === null ? "" : ` · Seed ${generation.seed}`}
              </small>
            </div>
            <div
              className="video-player-prompt-readonly"
              role="textbox"
              aria-label={ui.generation.submittedPrompt}
              aria-readonly="true"
              tabIndex={0}
            >
              {generation.prompt}
            </div>
          </section>
        )}
        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}
        {missing && <p className="muted">{ui.missing}</p>}
        {src && !failed && expectedKind === "video" && (
          <video
            className="video-player"
            src={src}
            controls
            autoPlay
            playsInline
            onError={() => setFailed(true)}
          />
        )}
        {src && !failed && expectedKind === "audio" && (
          <audio
            className="audio-player"
            src={src}
            controls
            autoPlay
            onError={() => setFailed(true)}
          />
        )}
        {failed && <p className="warning-text">{ui.decodeError}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {ui.cancel}
          </button>
        </div>
      </section>
    </div>
  );
}
