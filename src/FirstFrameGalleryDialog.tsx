import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import {
  clampGalleryIndex,
  coverflowSlotStyle,
  firstFrameReference,
  stepGalleryIndex,
} from "./firstFrameGallery";
import { ui } from "./i18n";
import { withMediaRevision } from "./mediaUrl";
import type { Project, Storyboard } from "./types";

type FrameItemState = {
  checking: boolean;
  exists: boolean;
  src: string;
  error: string;
  decodeFailed: boolean;
};

const EMPTY_STATE: FrameItemState = {
  checking: false,
  exists: false,
  src: "",
  error: "",
  decodeFailed: false,
};

export default function FirstFrameGalleryDialog({
  project,
  document,
  board,
  refreshKey,
  initialIndex = 0,
  discardedShotIds = [],
  onLocate,
  onClose,
}: {
  project: Project;
  document: string;
  board: Storyboard;
  refreshKey: number;
  initialIndex?: number;
  discardedShotIds?: readonly string[];
  onLocate: (index: number) => void;
  onClose: () => void;
}) {
  const cards = board.cards;
  const [activeIndex, setActiveIndex] = useState(() =>
    clampGalleryIndex(initialIndex, cards.length),
  );
  const [mediaMap, setMediaMap] = useState<Record<number, FrameItemState>>({});
  const dialogRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const lastWheelAt = useRef(0);

  const safeIndex = clampGalleryIndex(activeIndex, cards.length);
  const references = useMemo(
    () => cards.map((card) => firstFrameReference(card)),
    [cards],
  );
  const discardedSet = useMemo(
    () => new Set(discardedShotIds),
    [discardedShotIds],
  );

  useEffect(() => {
    setActiveIndex((current) => clampGalleryIndex(current, cards.length));
  }, [cards.length]);

  useEffect(() => {
    const previousFocus = window.document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const initial: Record<number, FrameItemState> = {};
    references.forEach((reference, index) => {
      initial[index] = reference
        ? { checking: true, exists: false, src: "", error: "", decodeFailed: false }
        : EMPTY_STATE;
    });
    setMediaMap(initial);

    void Promise.all(
      references.map(async (reference, index) => {
        if (!reference) return;
        try {
          const media = await api.media(project.handle, document, reference);
          if (!alive) return;
          const src =
            media.exists && media.path && media.kind === "image"
              ? withMediaRevision(
                  convertFileSrc(media.path),
                  `${refreshKey}:${media.revision ?? ""}`,
                )
              : "";
          const exists = Boolean(src);
          setMediaMap((current) => ({
            ...current,
            [index]: {
              checking: false,
              exists,
              src,
              error: "",
              decodeFailed: false,
            },
          }));
        } catch (cause) {
          if (!alive) return;
          setMediaMap((current) => ({
            ...current,
            [index]: {
              checking: false,
              exists: false,
              src: "",
              error: errorMessage(cause),
              decodeFailed: false,
            },
          }));
        }
      }),
    );

    return () => {
      alive = false;
    };
  }, [project.handle, document, references, refreshKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActiveIndex((current) =>
          stepGalleryIndex(current, -1, cards.length),
        );
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setActiveIndex((current) => stepGalleryIndex(current, 1, cards.length));
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(Math.max(0, cards.length - 1));
      } else if (event.key === "Enter" && cards.length > 0) {
        const target = event.target as HTMLElement | null;
        if (target && target.closest("button, a, input, select, textarea")) {
          return;
        }
        event.preventDefault();
        onLocate(safeIndex);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cards.length, onClose, onLocate, safeIndex]);

  useEffect(() => {
    const activePill = stripRef.current?.querySelector<HTMLButtonElement>(
      `button[data-shot-index="${safeIndex}"]`,
    );
    activePill?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
      behavior: "smooth",
    });
  }, [safeIndex]);

  const readyCount = useMemo(
    () =>
      cards.reduce(
        (count, _, index) =>
          mediaMap[index]?.exists && !mediaMap[index]?.decodeFailed
            ? count + 1
            : count,
        0,
      ),
    [cards, mediaMap],
  );

  const currentCard = cards[safeIndex];
  const currentRef = references[safeIndex] ?? "";
  const currentState = mediaMap[safeIndex] ?? EMPTY_STATE;
  const currentDiscarded = currentCard
    ? discardedSet.has(currentCard.id)
    : false;
  const currentStory = currentCard?.fields.story.value.trim() ?? "";

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (cards.length <= 1) return;
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (Math.abs(delta) < 12) return;
    const now = Date.now();
    if (now - lastWheelAt.current < 150) return;
    lastWheelAt.current = now;
    setActiveIndex((current) =>
      stepGalleryIndex(current, delta > 0 ? 1 : -1, cards.length),
    );
  };

  return (
    <div
      className="modal-backdrop frame-gallery-backdrop"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal frame-gallery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="frame-gallery-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="frame-gallery-header">
          <div className="frame-gallery-heading-group">
            <h2 id="frame-gallery-title" className="frame-gallery-sr-title">
              {ui.frameGallery.title}
            </h2>
            {currentCard ? (
              <button
                type="button"
                className={`frame-gallery-shot-trigger ${currentDiscarded ? "is-discarded" : ""}`}
                title={ui.frameGallery.locateHint}
                onClick={() => onLocate(safeIndex)}
              >
                <span className="frame-gallery-shot-id">{currentCard.id}</span>
                <span className="frame-gallery-shot-title">
                  {currentCard.title || currentCard.id}
                </span>
                {currentDiscarded && (
                  <span className="frame-gallery-discarded-tag">
                    {ui.board.discardedShot}
                  </span>
                )}
                <span className="frame-gallery-locate-cue">
                  {ui.frameGallery.locateShot} ↗
                </span>
              </button>
            ) : (
              <strong className="frame-gallery-empty-title">
                {ui.frameGallery.title}
              </strong>
            )}
          </div>
          <div className="frame-gallery-header-meta">
            {cards.length > 0 && (
              <>
                <span className="frame-gallery-counter">
                  {safeIndex + 1} / {cards.length}
                </span>
                <span className="frame-gallery-summary">
                  {ui.frameGallery.summary(readyCount, cards.length)}
                </span>
              </>
            )}
            <button
              type="button"
              className="frame-gallery-close"
              aria-label={ui.frameGallery.close}
              title={ui.frameGallery.close}
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        {cards.length === 0 ? (
          <div className="frame-gallery-empty">{ui.frameGallery.empty}</div>
        ) : (
          <>
            <div
              className="frame-gallery-stage"
              onWheel={handleWheel}
            >
              <button
                type="button"
                className="frame-gallery-nav frame-gallery-nav-prev"
                aria-label={ui.frameGallery.previous}
                title={ui.frameGallery.previous}
                disabled={safeIndex <= 0}
                onClick={() =>
                  setActiveIndex((current) =>
                    stepGalleryIndex(current, -1, cards.length),
                  )
                }
              >
                ‹
              </button>

              <div className="frame-gallery-deck">
                {cards.map((card, index) => {
                  const offset = index - safeIndex;
                  const slot = coverflowSlotStyle(offset);
                  if (!slot.visible) return null;
                  const state = mediaMap[index] ?? EMPTY_STATE;
                  const reference = references[index] ?? "";
                  const filename = reference.replace(/.*[/\\]/, "");
                  const isCenter = offset === 0;
                  const isDiscarded = discardedSet.has(card.id);
                  const hasImage = Boolean(
                    state.exists && state.src && !state.decodeFailed,
                  );

                  return (
                    <button
                      key={`${card.id}-${index}`}
                      type="button"
                      className={[
                        "frame-gallery-card",
                        isCenter ? "is-center" : "is-side",
                        !hasImage && !state.checking ? "is-missing" : "",
                        isDiscarded ? "is-discarded" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-offset={offset}
                      data-shot-id={card.id}
                      aria-label={
                        isCenter
                          ? ui.frameGallery.clickToLocate(card.id)
                          : `${card.id}${card.title ? ` ${card.title}` : ""}`
                      }
                      aria-current={isCenter ? "true" : undefined}
                      tabIndex={isCenter ? 0 : -1}
                      style={{
                        transform: `translate(-50%, -50%) translateX(${slot.translateXPercent}%) scale(${slot.scale})`,
                        zIndex: slot.zIndex,
                        opacity: slot.opacity,
                        filter:
                          slot.brightness < 1
                            ? `brightness(${slot.brightness})`
                            : undefined,
                        pointerEvents: slot.interactive ? "auto" : "none",
                      }}
                      onClick={() => {
                        if (isCenter) onLocate(index);
                        else setActiveIndex(index);
                      }}
                    >
                      <div className="frame-gallery-card-frame">
                        {hasImage ? (
                          <img
                            src={state.src}
                            alt={`${card.id} ${filename || ui.board.frameImage}`}
                            draggable={false}
                            onError={() =>
                              setMediaMap((current) => ({
                                ...current,
                                [index]: {
                                  ...(current[index] ?? EMPTY_STATE),
                                  decodeFailed: true,
                                },
                              }))
                            }
                          />
                        ) : (
                          <div className="frame-gallery-placeholder">
                            <span className="frame-gallery-placeholder-id">
                              {card.id}
                            </span>
                            <strong>
                              {state.checking
                                ? ui.frameGallery.checking
                                : state.decodeFailed
                                  ? ui.decodeError
                                  : state.error
                                    ? state.error
                                    : reference
                                      ? ui.frameGallery.missingFrame
                                      : ui.frameGallery.noFrameRef}
                            </strong>
                            {filename && (
                              <small title={reference}>{filename}</small>
                            )}
                          </div>
                        )}
                        {!isCenter && (
                          <span className="frame-gallery-side-badge">
                            {card.id}
                          </span>
                        )}
                        {isCenter && (
                          <span className="frame-gallery-center-cue">
                            {ui.frameGallery.clickToLocate(card.id)} ↗
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                className="frame-gallery-nav frame-gallery-nav-next"
                aria-label={ui.frameGallery.next}
                title={ui.frameGallery.next}
                disabled={safeIndex >= cards.length - 1}
                onClick={() =>
                  setActiveIndex((current) =>
                    stepGalleryIndex(current, 1, cards.length),
                  )
                }
              >
                ›
              </button>
            </div>

            <footer className="frame-gallery-footer">
              <div className="frame-gallery-caption">
                <div className="frame-gallery-caption-main">
                  <span
                    className={`frame-gallery-file ${
                      currentRef && !currentState.exists && !currentState.checking
                        ? "is-missing"
                        : ""
                    }`}
                    title={currentRef || ui.frameGallery.noFrameRef}
                  >
                    {currentRef
                      ? currentRef.replace(/.*[/\\]/, "")
                      : ui.frameGallery.noFrameRef}
                  </span>
                  {currentRef &&
                    !currentState.checking &&
                    !currentState.exists && (
                      <span className="frame-gallery-status-badge is-missing">
                        {ui.missing}
                      </span>
                    )}
                  {currentStory && (
                    <span className="frame-gallery-story" title={currentStory}>
                      {currentStory}
                    </span>
                  )}
                </div>
                <span className="frame-gallery-shortcut-hint">
                  {ui.frameGallery.keyboardHint}
                </span>
              </div>

              <div
                ref={stripRef}
                className="frame-gallery-strip"
                role="tablist"
                aria-label={ui.shots}
              >
                {cards.map((card, index) => {
                  const state = mediaMap[index] ?? EMPTY_STATE;
                  const ref = references[index] ?? "";
                  const missing =
                    !state.checking && (!ref || !state.exists || state.decodeFailed);
                  const discarded = discardedSet.has(card.id);
                  const active = index === safeIndex;
                  return (
                    <button
                      key={`strip-${card.id}-${index}`}
                      type="button"
                      role="tab"
                      data-shot-index={index}
                      aria-selected={active}
                      className={[
                        "frame-gallery-pill",
                        active ? "is-active" : "",
                        missing ? "is-missing" : "",
                        discarded ? "is-discarded" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={`${card.id}${card.title ? ` · ${card.title}` : ""}`}
                      onClick={() => setActiveIndex(index)}
                    >
                      {card.id}
                    </button>
                  );
                })}
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
