import { useEffect, useRef, useState } from "react";
import Preview, { Asset } from "./Preview";
import { analyzeMarkdown, normalizeReference } from "./markdown";
import {
  addPatch,
  applySourcePatch,
  canMove,
  deletePatch,
  fieldPatch,
  movePatch,
} from "./storyboard";
import { ui } from "./i18n";
import { errorMessage } from "./api";
import EpisodeOverview, { ShotCast } from "./EpisodeOverview";
import GenerationPanel from "./GenerationPanel";
import type {
  BoardField,
  Project,
  ShotCard,
  SourceField,
  SourcePatch,
  Storyboard as Board,
} from "./types";

function LazyAsset(props: Parameters<typeof Asset>[0]) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="lazy-asset">
      {visible ? (
        <Asset {...props} />
      ) : (
        <div className="media-placeholder">{props.reference}</div>
      )}
    </div>
  );
}

export default function BoardView({
  board,
  project,
  document,
  refreshKey,
  busy,
  apply,
  source,
  active,
  select,
  generationConfigured,
  configureGeneration,
  useVideo,
}: {
  board: Board;
  project: Project;
  document: string;
  refreshKey: number;
  busy: boolean;
  apply: (patch: SourcePatch, nextIndex?: number) => boolean;
  source: (offset: number) => void;
  active: number;
  select: (index: number) => void;
  generationConfigured: boolean;
  configureGeneration: () => void;
  useVideo: (index: number, reference: string) => Promise<void>;
}) {
  const [deletion, setDeletion] = useState<{
    index: number;
    patch: SourcePatch;
  } | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (deletion) cancel.current?.focus();
  }, [deletion]);
  const asset = (reference: string) => (
    <LazyAsset
      key={reference}
      project={project}
      document={document}
      reference={reference}
      refreshKey={refreshKey}
    />
  );
  function field(card: ShotCard, key: BoardField, multiline = false) {
    const f = card.fields[key];
    return (
      <Field
        key={key}
        label={ui.board[key]}
        field={f}
        multiline={multiline}
        disabled={busy || board.episode.format === "unsupported"}
        placeholder={key === "story" ? ui.board.emptyStory : undefined}
        change={(value) => apply(fieldPatch(board, f, value))}
        source={() => source(f.range?.start ?? card.offset)}
      />
    );
  }
  return (
    <div className="storyboard-scroll">
      <div className="board-heading">
        <div>
          <span className="board-eyebrow">STORYBOARD</span>
          <h1>{document.split("/").at(-1)?.replace(/\.md$/i, "")}</h1>
          <p>{ui.board.count(board.cards.length)}</p>
        </div>
        <button
          disabled={busy || board.episode.format === "unsupported"}
          onClick={() => apply(addPatch(board, document), board.cards.length)}
        >
          ＋ {ui.board.add}
        </button>
      </div>
      {board.diagnostics.map((message) => (
        <p className="diagnostic" key={message}>
          {message}
        </p>
      ))}
      {board.episode.format !== "document" && (
        <EpisodeOverview
          episode={board.episode}
          asset={asset}
          source={() => source(0)}
        />
      )}
      {board.sections.map((section, sectionIndex) => {
        if (board.episode.format === "unsupported") return null;
        if (section.kind === "document") {
          if (board.episode.format !== "document") return null;
          const raw = board.source.slice(
            section.range.start,
            section.range.end,
          );
          if (!raw.trim()) return null;
          return (
            <section
              className="board-document"
              key={`document-${sectionIndex}`}
            >
              <div className="board-section-heading">
                <strong>
                  {sectionIndex === 0 ? ui.board.episodeInfo : ui.board.extra}
                </strong>
                <button onClick={() => source(section.range.start)}>
                  {ui.board.source}
                </button>
              </div>
              <Preview text={raw} />
              <details className="shot-details">
                <summary>{ui.assets}</summary>
                <PublicAssets
                  references={analyzeMarkdown(raw).references}
                  asset={asset}
                />
              </details>
            </section>
          );
        }
        const index = section.index,
          card = board.cards[index];
        const video = normalizeReference(card.fields.videoFile.value);
        return (
          <article
            id={`shot-card-${index}`}
            key={`shot-${index}`}
            data-shot-id={card.id}
            className={`shot-card ${active === index ? "is-selected" : ""}`}
            onFocusCapture={() => select(index)}
            onClick={() => select(index)}
          >
            <header className="shot-card-heading">
              <span className="shot-number">{card.id}</span>
              <div className="shot-title">{field(card, "title")}</div>
              <div
                className="shot-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  aria-label={`${card.id} ${ui.board.up}`}
                  title={ui.board.up}
                  disabled={busy || !canMove(board, index, -1)}
                  onClick={() => apply(movePatch(board, index, -1), index - 1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`${card.id} ${ui.board.down}`}
                  title={ui.board.down}
                  disabled={busy || !canMove(board, index, 1)}
                  onClick={() => apply(movePatch(board, index, 1), index + 1)}
                >
                  ↓
                </button>
                <button disabled={busy} onClick={() => source(card.offset)}>
                  {ui.board.source}
                </button>
                <button
                  aria-label={`${card.id} ${ui.board.remove}`}
                  disabled={busy}
                  onClick={() =>
                    setDeletion({ index, patch: deletePatch(board, index) })
                  }
                >
                  ×
                </button>
              </div>
            </header>
            <div className="shot-main">
              <div className="shot-media">
                {video ? (
                  <LazyAsset
                    key={video}
                    project={project}
                    document={document}
                    reference={video}
                    refreshKey={refreshKey}
                    hero
                  />
                ) : (
                  <div className="video-placeholder">▷ {ui.board.noVideo}</div>
                )}
              </div>
              <div className="shot-narrative">
                {field(card, "story", true)}
                <ShotCast episode={board.episode} shotId={card.id} />
                <GenerationPanel
                  card={card}
                  board={board}
                  episode={board.episode}
                  project={project}
                  document={document}
                  refreshKey={refreshKey}
                  busy={busy}
                  configured={generationConfigured}
                  configure={configureGeneration}
                  apply={apply}
                  useVideo={(reference) => useVideo(index, reference)}
                  renderField={(key, multiline) => field(card, key, multiline)}
                />
              </div>
            </div>
            <details className="shot-details">
              <summary>{ui.board.original}</summary>
              <div className="prompt-grid">
                {field(card, "framePrompt", true)}
              </div>
              <div className="parameter-grid">
                {field(card, "frameFile")}
                {field(card, "videoFile")}
              </div>
              <ReferenceList
                card={card}
                board={board}
                apply={apply}
                busy={busy}
                source={source}
                asset={asset}
              />
            </details>
            {card.diagnostics.map((message) => (
              <p className="diagnostic" key={message}>
                {message}
              </p>
            ))}
            <div className="shot-details source-details">
              <button
                className="text-button"
                onClick={() => source(card.offset)}
              >
                {ui.board.source}
              </button>
            </div>
          </article>
        );
      })}
      {deletion && (
        <div
          className="modal-backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape") setDeletion(null);
            if (event.key === "Tab") {
              const buttons =
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
                );
              if (event.shiftKey && documentActive() === buttons[0]) {
                event.preventDefault();
                buttons[1].focus();
              } else if (!event.shiftKey && documentActive() === buttons[1]) {
                event.preventDefault();
                buttons[0].focus();
              }
            }
          }}
        >
          <section
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-hint"
          >
            <h2 id="delete-title">{ui.board.removeTitle}</h2>
            <p id="delete-hint">{ui.board.removeHint}</p>
            <div className="modal-actions">
              <button ref={cancel} onClick={() => setDeletion(null)}>
                {ui.cancel}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  apply(deletion.patch, Math.max(0, deletion.index - 1));
                  setDeletion(null);
                }}
              >
                {ui.board.confirmRemove}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
const documentActive = () => window.document.activeElement;

function PublicAssets({
  references,
  asset,
}: {
  references: string[];
  asset: (reference: string) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current?.closest("details");
    const toggle = () => setOpen(details?.open ?? false);
    details?.addEventListener("toggle", toggle);
    toggle();
    return () => details?.removeEventListener("toggle", toggle);
  }, []);
  return (
    <div ref={ref} className="reference-grid">
      {open && references.map(asset)}
      {!references.length && <p className="muted">{ui.noAssets}</p>}
    </div>
  );
}

function Field({
  label,
  field,
  multiline,
  disabled,
  placeholder,
  change,
  source,
  finish,
}: {
  label: string;
  field: SourceField;
  multiline?: boolean;
  disabled: boolean;
  placeholder?: string;
  change: (value: string) => boolean | void;
  source: () => void;
  finish?: () => void;
}) {
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(field.value);
  const lastSubmitted = useRef<string | null>(null);
  useEffect(() => {
    if (
      lastSubmitted.current === null ||
      field.value.trim() !== lastSubmitted.current.trim()
    )
      setDraft(field.value);
  }, [field.value]);
  const edit = (value: string) => {
    try {
      if (change(value) === false) return;
      lastSubmitted.current = value;
      setDraft(value);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const blur = () => {
    lastSubmitted.current = null;
    setDraft(field.value);
    finish?.();
  };
  return (
    <label className="board-field">
      <span>{label}</span>
      {field.ambiguous ? (
        <button type="button" onClick={source}>
          {ui.board.source}
        </button>
      ) : multiline ? (
        <textarea
          aria-label={label}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => edit(event.target.value)}
          onBlur={blur}
          rows={5}
        />
      ) : (
        <input
          aria-label={label}
          value={draft}
          disabled={disabled}
          onChange={(event) => edit(event.target.value)}
          onBlur={blur}
        />
      )}
      {error && (
        <span role="alert" className="warning-text">
          {error}
        </span>
      )}
    </label>
  );
}

function ReferenceList({
  card,
  board,
  apply,
  busy,
  source,
  asset,
}: {
  card: ShotCard;
  board: Board;
  apply: (patch: SourcePatch) => boolean;
  busy: boolean;
  source: (offset: number) => void;
  asset: (reference: string) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Keep the edited source range mounted while a filename temporarily has no extension.
  // The text is still patched immediately; this is only an editing-location bookmark.
  const [editing, setEditing] = useState<{
    source: string;
    reference: string;
    field: SourceField;
  } | null>(null);
  const pinned = editing?.source === board.source ? editing : null;
  const references = pinned
    ? [
        ...card.references.filter(
          (entry) => entry.field.range?.start !== pinned.field.range?.start,
        ),
        { reference: pinned.reference, field: pinned.field },
      ].sort(
        (a, b) => (a.field.range?.start ?? 0) - (b.field.range?.start ?? 0),
      )
    : card.references;
  // Mount secondary media only when its enclosing details is opened.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const details = ref.current?.closest("details");
    const toggle = () => setOpen(details?.open ?? false);
    details?.addEventListener("toggle", toggle);
    toggle();
    return () => details?.removeEventListener("toggle", toggle);
  }, []);
  return (
    <div ref={ref} className="reference-grid">
      {references.map(({ reference, field }, i) => (
        <div key={field.range?.start ?? `unknown-${i}`}>
          <Field
            label={
              field.range &&
              (field.range.start < card.offset || field.range.end > card.end)
                ? ui.board.sharedReference
                : ui.board.reference
            }
            field={field}
            disabled={busy}
            change={(value) => {
              const patch = fieldPatch(board, field, value);
              if (!apply(patch)) return false;
              setEditing({
                source: applySourcePatch(board.source, patch),
                reference: normalizeReference(value) ?? "",
                field: {
                  ...field,
                  value: patch.replacement,
                  range: {
                    start: patch.range.start,
                    end: patch.range.start + patch.replacement.length,
                  },
                },
              });
            }}
            finish={() => setEditing(null)}
            source={() => source(field.range?.start ?? card.offset)}
          />
          {open && reference && asset(reference)}
        </div>
      ))}
    </div>
  );
}
