import { useEffect, useRef, useState, type PointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import { withMediaRevision } from "./mediaUrl";
import type { Project } from "./types";
import {
  clampTrimRange,
  formatTimecode,
  isTimelineDrag,
  MIN_TRIM_SPAN,
  ratioFromTime,
  timeFromRatio,
  trimUnchanged,
} from "./videoTrim";

type TimelineGesture = {
  pointerId: number;
  pointerDownX: number;
  moved: boolean;
};

function releaseVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

export default function VideoTrimModal({
  project,
  document,
  reference,
  refreshKey = 0,
  onClose,
  onSaved,
}: {
  project: Project;
  document: string;
  reference: string;
  refreshKey?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"in" | "out" | null>(null);
  const timelineGestureRef = useRef<TimelineGesture | null>(null);
  const rangeRef = useRef({ start: 0, end: 0 });
  const rangedRef = useRef(false);
  const [src, setSrc] = useState("");
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);

  rangeRef.current = { start, end };

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
        if (media.kind !== "video") {
          setError(ui.videoPlayer.notVideo);
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
      rangedRef.current = false;
      releaseVideo(videoRef.current);
    };
  }, [project.handle, document, reference, refreshKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!saving) onClose();
        return;
      }
      const video = videoRef.current;
      if (!video || saving) return;
      if (event.key === " ") {
        event.preventDefault();
        if (video.paused) void video.play();
        else video.pause();
      } else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        setRange(video.currentTime, rangeRef.current.end);
      } else if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        setRange(rangeRef.current.start, video.currentTime);
      } else if (event.key === "Home") {
        event.preventDefault();
        video.currentTime = rangeRef.current.start;
      } else if (event.key === "End") {
        event.preventDefault();
        video.currentTime = rangeRef.current.end;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const setRange = (
    nextStart: number,
    nextEnd: number,
    durationHint = duration,
  ) => {
    const next = clampTrimRange(nextStart, nextEnd, durationHint);
    rangeRef.current = next;
    setStart(next.start);
    setEnd(next.end);
    return next;
  };

  const timeAt = (clientX: number) => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    return timeFromRatio((clientX - rect.left) / rect.width, duration);
  };

  const onLoaded = () => {
    const video = videoRef.current;
    if (!video) return;
    const length = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(length);
    const next = rangedRef.current
      ? setRange(rangeRef.current.start, rangeRef.current.end, length)
      : setRange(0, length, length);
    rangedRef.current = true;
    video.currentTime = next.start;
    setCurrent(next.start);
  };

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const { start: inPoint, end: outPoint } = rangeRef.current;
    if (video.currentTime < inPoint - 0.04) {
      video.currentTime = inPoint;
      return;
    }
    if (video.currentTime >= outPoint) {
      video.pause();
      video.currentTime = outPoint;
      setPlaying(false);
    }
    setCurrent(video.currentTime);
  };

  const seek = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    const { start: inPoint, end: outPoint } = rangeRef.current;
    const next = Math.min(Math.max(time, inPoint), outPoint);
    video.currentTime = next;
    setCurrent(next);
  };

  const beginDrag = (which: "in" | "out") => (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = which;
    event.currentTarget.setPointerCapture(event.pointerId);
    videoRef.current?.pause();
  };

  const onHandlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const time = timeAt(event.clientX);
    if (dragRef.current === "in") {
      const next = setRange(time, end);
      seek(next.start);
    } else {
      const next = setRange(start, time);
      seek(next.end);
    }
  };

  const endHandleDrag = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragRef.current) {
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    }
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || duration <= 0 || saving) return;
    event.preventDefault();
    timelineGestureRef.current = {
      pointerId: event.pointerId,
      pointerDownX: event.clientX,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = timelineGestureRef.current;
    if (
      gesture &&
      gesture.pointerId === event.pointerId &&
      isTimelineDrag(gesture.pointerDownX, event.clientX)
    ) {
      gesture.moved = true;
      event.preventDefault();
    }
  };

  const endTimelineGesture = (
    event: PointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const gesture = timelineGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const moved =
      gesture.moved || isTimelineDrag(gesture.pointerDownX, event.clientX);
    if (!cancelled && !moved) seek(timeAt(event.clientX));
    timelineGestureRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const save = async () => {
    const video = videoRef.current;
    const previous = src;
    setSaving(true);
    setError("");
    releaseVideo(video);
    setSrc("");
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      await api.trimMedia(project.handle, document, reference, start, end);
      onSaved();
    } catch (e) {
      setSrc(previous);
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  const label = reference.replace(/.*[/\\]/, "");
  const keep = Math.max(end - start, 0);
  const unchanged = trimUnchanged(start, end, duration);
  const inRatio = ratioFromTime(start, duration);
  const outRatio = ratioFromTime(end, duration);
  const playRatio = ratioFromTime(current, duration);

  return (
    <div
      className="modal-backdrop video-trim-backdrop"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <section
        className="video-trim-studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-trim-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="video-trim-toolbar">
          <div>
            <p className="video-trim-kicker">{ui.generation.trim}</p>
            <h2 id="video-trim-title">{label}</h2>
          </div>
          <div className="video-trim-clock" aria-live="polite">
            <strong>{formatTimecode(keep)}</strong>
            <span>
              {formatTimecode(start)} → {formatTimecode(end)}
            </span>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={ui.cancel}
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="video-trim-stage">
          {error && (
            <p className="generation-error" role="alert">
              {error}
            </p>
          )}
          {missing && <p className="muted">{ui.missing}</p>}
          {src && !failed ? (
            <video
              ref={videoRef}
              className="video-trim-player"
              src={src}
              playsInline
              onLoadedMetadata={onLoaded}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() => setFailed(true)}
            />
          ) : (
            <div className="video-trim-empty">
              {failed ? ui.decodeError : ui.generation.trimStage}
            </div>
          )}
        </div>
        <div className="video-trim-deck">
          <div className="video-trim-transport">
            <button
              type="button"
              className="video-trim-play"
              disabled={!src || failed || saving || duration <= 0}
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                if (video.paused) {
                  if (
                    video.currentTime < start ||
                    video.currentTime >= end - 0.02
                  ) {
                    video.currentTime = start;
                  }
                  void video.play();
                } else video.pause();
              }}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <span className="video-trim-now">{formatTimecode(current)}</span>
            <span className="video-trim-hint">{ui.generation.trimHint}</span>
          </div>
          <div
            ref={trackRef}
            className="video-trim-track"
            role="slider"
            aria-label={ui.generation.trimTimeline}
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={current}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={endTimelineGesture}
            onPointerCancel={(event) => endTimelineGesture(event, true)}
          >
            <div
              className="video-trim-discard"
              style={{ width: `${inRatio * 100}%` }}
            />
            <div
              className="video-trim-keep"
              style={{
                left: `${inRatio * 100}%`,
                width: `${Math.max(outRatio - inRatio, 0) * 100}%`,
              }}
            />
            <button
              type="button"
              className="video-trim-handle in"
              style={{ left: `${inRatio * 100}%` }}
              aria-label={ui.generation.trimIn}
              onPointerDown={beginDrag("in")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={endHandleDrag}
              onPointerCancel={endHandleDrag}
            />
            <button
              type="button"
              className="video-trim-handle out"
              style={{ left: `${outRatio * 100}%` }}
              aria-label={ui.generation.trimOut}
              onPointerDown={beginDrag("out")}
              onPointerMove={onHandlePointerMove}
              onPointerUp={endHandleDrag}
              onPointerCancel={endHandleDrag}
            />
            <div
              className="video-trim-playhead"
              style={{ left: `${playRatio * 100}%` }}
            />
          </div>
          <div className="video-trim-marks">
            <span>
              {ui.generation.trimIn} {formatTimecode(start)}
            </span>
            <span>{formatTimecode(duration)}</span>
            <span>
              {ui.generation.trimOut} {formatTimecode(end)}
            </span>
          </div>
        </div>
        <footer className="video-trim-actions">
          <p>{ui.generation.trimOverwrite}</p>
          <div>
            <button type="button" disabled={saving} onClick={onClose}>
              {ui.cancel}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                saving ||
                missing ||
                failed ||
                !src ||
                duration < MIN_TRIM_SPAN ||
                unchanged
              }
              onClick={() => void save()}
            >
              {saving ? ui.generation.trimming : ui.save}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
