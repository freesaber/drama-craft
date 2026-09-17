import { useEffect, useRef, useState } from "react";
import Preview, { Asset } from "./Preview";
import { analyzeMarkdown, isProjectRelativeImage, normalizeReference } from "./markdown";
import { fieldPatch } from "./storyboard";
import { ui } from "./i18n";
import { api, chooseMedia, desktop, errorMessage } from "./api";
import EpisodeOverview from "./EpisodeOverview";
import GenerationPanel from "./GenerationPanel";
import {
  alignResolutionOption,
  type VideoApiOptions,
} from "./videoWorkflows";
import type {
  BoardField,
  Project,
  ShotCard,
  SourceField,
  SourcePatch,
  Storyboard as Board,
} from "./types";

function LazyAsset(
  props: Parameters<typeof Asset>[0] & {
    onAvailability?: (exists: boolean) => void;
  },
) {
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
  videoWorkflow,
  configureGeneration,
  useVideo,
  showSourceActions = true,
  onMediaPlaced,
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
  videoWorkflow: VideoApiOptions;
  configureGeneration: () => void;
  useVideo: (index: number, reference: string) => Promise<void>;
  showSourceActions?: boolean;
  onMediaPlaced?: () => void;
}) {
  const asset = (
    reference: string,
    onAvailability?: (exists: boolean) => void,
  ) => (
    <LazyAsset
      key={`${reference}:${refreshKey}`}
      project={project}
      document={document}
      reference={reference}
      refreshKey={refreshKey}
      onAvailability={onAvailability}
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
        options={
          key === "resolution"
            ? [...videoWorkflow.resolutions]
            : key === "duration"
              ? Array.from({ length: 15 }, (_, i) => String(i + 1))
              : undefined
        }
        alignOptions={key === "resolution"}
        change={(value) => apply(fieldPatch(board, f, value))}
        source={
          showSourceActions
            ? () => source(f.range?.start ?? card.offset)
            : undefined
        }
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
      </div>
      {board.diagnostics.map((message) => (
        <p className="diagnostic" key={message}>
          {message}
        </p>
      ))}
      {board.episode.format !== "document" && (
        <EpisodeOverview
          episode={board.episode}
          project={project}
          document={document}
          busy={busy}
          asset={asset}
          onMediaPlaced={onMediaPlaced}
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
                {showSourceActions && (
                  <button onClick={() => source(section.range.start)}>
                    {ui.board.source}
                  </button>
                )}
              </div>
              <Preview text={raw} />
              {showSourceActions && (
                <details className="shot-details">
                  <summary>{ui.assets}</summary>
                  <PublicAssets
                    references={analyzeMarkdown(raw).references}
                    asset={asset}
                  />
                </details>
              )}
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
              {showSourceActions && (
                <div
                  className="shot-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button disabled={busy} onClick={() => source(card.offset)}>
                    {ui.board.source}
                  </button>
                </div>
              )}
            </header>
            <GenerationPanel
              video={
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
                    <div className="video-placeholder">
                      ▷ {ui.board.noVideo}
                    </div>
                  )}
                </div>
              }
              card={card}
              episode={board.episode}
              project={project}
              document={document}
              refreshKey={refreshKey}
              busy={busy}
              configured={generationConfigured}
              videoWorkflow={videoWorkflow}
              configure={configureGeneration}
              useVideo={(reference) => useVideo(index, reference)}
              renderField={(key, multiline) => field(card, key, multiline)}
            />
            <section className="shot-details shot-frame-area">
              <h3>{ui.board.frameImage}</h3>
              <FrameImageTabs
                key={`${document}-${index}`}
                assets={card.frameAssets}
                frameFile={card.fields.frameFile.value.trim()}
                place={
                  <FrameFilePlace
                    project={project}
                    document={document}
                    frameFile={card.fields.frameFile.value.trim()}
                    refreshKey={refreshKey}
                    busy={busy}
                    onPlaced={onMediaPlaced}
                  />
                }
                asset={(reference) => (
                  <LazyAsset
                    project={project}
                    document={document}
                    reference={reference}
                    refreshKey={refreshKey}
                    hero
                  />
                )}
                prompt={field(card, "framePrompt", true)}
              />
            </section>
            {card.diagnostics.map((message) => (
              <p className="diagnostic" key={message}>
                {message}
              </p>
            ))}
          </article>
        );
      })}
    </div>
  );
}

function FrameFilePlace({
  project,
  document,
  frameFile,
  refreshKey,
  busy,
  onPlaced,
}: {
  project: Project;
  document: string;
  frameFile: string;
  refreshKey: number;
  busy: boolean;
  onPlaced?: () => void;
}) {
  const [exists, setExists] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");
  const canPlace = desktop && isProjectRelativeImage(frameFile);
  useEffect(() => {
    if (!canPlace) {
      setExists(false);
      return;
    }
    let alive = true;
    void api
      .media(project.handle, document, frameFile)
      .then((media) => {
        if (alive) setExists(media.exists);
      })
      .catch(() => {
        if (alive) setExists(false);
      });
    return () => {
      alive = false;
    };
  }, [canPlace, project.handle, document, frameFile, refreshKey]);
  if (!canPlace) return null;
  return (
    <div className="shot-frame-place">
      <button
        type="button"
        className="episode-material-place shot-frame-place-button"
        title={`${ui.episodeData.mediaPlaceHint}：${frameFile}`}
        disabled={busy || placing}
        onClick={() => {
          void (async () => {
            setError("");
            setPlacing(true);
            try {
              const selected = await chooseMedia("image");
              if (!selected) return;
              await api.placeDocumentMedia(
                project.handle,
                document,
                frameFile,
                selected,
              );
              setExists(true);
              onPlaced?.();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setPlacing(false);
            }
          })();
        }}
      >
        {placing
          ? ui.busy
          : exists
            ? ui.episodeData.replaceImage
            : ui.episodeData.uploadImage}
      </button>
      {error && <p className="diagnostic">{error}</p>}
    </div>
  );
}

function FrameImageTabs({
  assets,
  frameFile,
  place,
  asset,
  prompt,
}: {
  assets: ShotCard["frameAssets"];
  frameFile: string;
  place: React.ReactNode;
  asset: (reference: string) => React.ReactNode;
  prompt: React.ReactNode;
}) {
  const [active, setActive] = useState<"frame" | "assets" | "prompt">("assets");
  const frameName = frameFile.replace(/.*[/\\]/, "");
  const tabs = [
    { id: "assets" as const, label: ui.board.materials },
    { id: "prompt" as const, label: ui.board.promptTab },
    { id: "frame" as const, label: ui.board.frameImage },
  ];
  return (
    <div className="frame-image-tabs">
      <div role="tablist" aria-label={ui.board.frameImage}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active === "frame" ? (
        <div role="tabpanel" className="frame-output-panel">
          {frameFile ? (
            <article className="frame-asset" key={`frame-${frameFile}`}>
              {asset(frameFile)}
              <strong title={frameFile}>
                {ui.board.frameFile}
                {frameName ? ` · ${frameName}` : ""}
              </strong>
            </article>
          ) : (
            <p className="muted">{ui.board.noFrame}</p>
          )}
          {place}
        </div>
      ) : active === "assets" ? (
        <div role="tabpanel" className="frame-assets">
          {assets.map((item) => {
            const filename = item.reference.replace(/.*[/\\]/, "");
            return (
              <article
                className="frame-asset"
                key={`${item.label}-${item.reference}`}
              >
                {asset(item.reference)}
                <strong
                  title={`${item.label} · ${item.name}\n${item.reference}`}
                >
                  {filename}
                </strong>
              </article>
            );
          })}
          {!assets.length && (
            <p className="muted">{ui.board.noFrameMaterials}</p>
          )}
        </div>
      ) : (
        <div role="tabpanel" className="frame-prompt-panel">
          {prompt}
        </div>
      )}
    </div>
  );
}

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
  options,
  alignOptions,
}: {
  label: string;
  field: SourceField;
  multiline?: boolean;
  disabled: boolean;
  placeholder?: string;
  change: (value: string) => boolean | void;
  source?: () => void;
  options?: string[];
  alignOptions?: boolean;
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
  };
  const selectValue =
    options && alignOptions
      ? (alignResolutionOption(draft, options) ?? draft)
      : draft;
  return (
    <label className="board-field">
      <span>{label}</span>
      {field.ambiguous ? (
        source ? (
          <button type="button" onClick={source}>
            {ui.board.source}
          </button>
        ) : (
          <span>{draft || "—"}</span>
        )
      ) : options ? (
        <select
          aria-label={label}
          value={selectValue}
          disabled={disabled}
          onChange={(event) => edit(event.target.value)}
          onBlur={blur}
        >
          {!options.includes(selectValue) && (
            <option value={draft}>{draft || "—"}</option>
          )}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
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
