import { useState } from "react";
import { api, chooseMedia, desktop, errorMessage } from "./api";
import { ui } from "./i18n";
import { isProjectRelativeImage } from "./markdown";
import type { EpisodeData, Project } from "./types";

export default function EpisodeOverview({
  episode,
  project,
  document,
  busy = false,
  asset,
  onMediaPlaced,
}: {
  episode: EpisodeData;
  project: Project;
  document: string;
  busy?: boolean;
  asset: (
    reference: string,
    onAvailability?: (exists: boolean) => void,
  ) => React.ReactNode;
  onMediaPlaced?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"roles" | "assets">("roles");
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState<{ name: string; text: string } | null>(
    null,
  );
  const [promptCopied, setPromptCopied] = useState(false);
  const [placingKey, setPlacingKey] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState("");
  const materialAssets = episode.assets.filter(
    (item) =>
      !episode.characters.some(
        (role) => role.image && role.image === item.reference,
      ),
  );
  const remember = (key: string, exists: boolean) =>
    setAvailability((current) =>
      current[key] === exists ? current : { ...current, [key]: exists },
    );
  const showPromptWhenMissing = (
    key: string,
    reference: string | null,
    name: string,
    text: string,
  ) => {
    if (!reference || availability[key] === false) {
      setPromptCopied(false);
      setPrompt({ name, text });
    }
  };
  const keyboardClick = (event: React.KeyboardEvent, click: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      click();
    }
  };
  const placeImage = async (key: string, reference: string) => {
    if (!desktop || busy || placingKey) return;
    setPlaceError("");
    setPlacingKey(key);
    try {
      const selected = await chooseMedia("image");
      if (!selected) return;
      await api.placeDocumentMedia(
        project.handle,
        document,
        reference,
        selected,
      );
      remember(key, true);
      onMediaPlaced?.();
    } catch (error) {
      setPlaceError(errorMessage(error));
    } finally {
      setPlacingKey(null);
    }
  };

  return (
    <section className="episode-overview">
      <div className="board-section-heading">
        <strong>{episode.title}</strong>
      </div>
      <p className="episode-summary">
        {episode.summary || ui.episodeData.noSummary}
      </p>
      {placeError && <p className="diagnostic">{placeError}</p>}
      <div className="episode-library-tabs">
        <div role="tablist" aria-label={ui.episodeData.material}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "roles"}
            onClick={() => setActiveTab("roles")}
          >
            {ui.episodeData.roleTab}
            <span>{episode.characters.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "assets"}
            onClick={() => setActiveTab("assets")}
          >
            {ui.episodeData.assetTab}
            <span>{materialAssets.length}</span>
          </button>
        </div>

        {activeTab === "roles" ? (
          <div role="tabpanel" className="episode-material-row">
            {episode.characters.map((role, index) => {
              const key = `role-${role.id}-${index}`;
              const openPrompt = () =>
                showPromptWhenMissing(
                  key,
                  role.image,
                  role.name,
                  role.imagePrompt,
                );
              const canPlace =
                !!role.imagePrompt && isProjectRelativeImage(role.image);
              return (
                <article
                  className="episode-material-card"
                  key={key}
                  data-character-id={role.id}
                  role="button"
                  tabIndex={0}
                  onClick={openPrompt}
                  onKeyDown={(event) => keyboardClick(event, openPrompt)}
                >
                  <div className="episode-material-preview">
                    {role.image ? (
                      asset(role.image, (exists) => remember(key, exists))
                    ) : (
                      <span className="media-placeholder">▧</span>
                    )}
                  </div>
                  <strong>{role.name}</strong>
                  <small>{role.id}</small>
                  <div
                    className="character-voice"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {role.voice ? asset(role.voice) : ui.episodeData.noVoice}
                  </div>
                  {canPlace && (
                    <button
                      type="button"
                      className="episode-material-place"
                      title={`${ui.episodeData.mediaPlaceHint}：${role.image}`}
                      disabled={busy || placingKey === key}
                      onClick={(event) => {
                        event.stopPropagation();
                        void placeImage(key, role.image!);
                      }}
                    >
                      {placingKey === key
                        ? ui.busy
                        : availability[key]
                          ? ui.episodeData.replaceImage
                          : ui.episodeData.uploadImage}
                    </button>
                  )}
                </article>
              );
            })}
            {!episode.characters.length && (
              <p className="muted">{ui.episodeData.noCharacters}</p>
            )}
          </div>
        ) : (
          <div role="tabpanel" className="episode-material-row">
            {materialAssets.map((item, index) => {
              const key = `asset-${item.id}-${index}`;
              const openPrompt = () =>
                showPromptWhenMissing(
                  key,
                  item.reference,
                  item.name,
                  item.prompt,
                );
              const canPlace =
                !!item.prompt && isProjectRelativeImage(item.reference);
              return (
                <article
                  className="episode-material-card"
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={openPrompt}
                  onKeyDown={(event) => keyboardClick(event, openPrompt)}
                >
                  <div className="episode-material-preview">
                    {item.reference ? (
                      asset(item.reference, (exists) => remember(key, exists))
                    ) : (
                      <span className="media-placeholder">▧</span>
                    )}
                  </div>
                  <strong>{item.name}</strong>
                  <small>{item.kind || item.id}</small>
                  {canPlace && (
                    <button
                      type="button"
                      className="episode-material-place"
                      title={`${ui.episodeData.mediaPlaceHint}：${item.reference}`}
                      disabled={busy || placingKey === key}
                      onClick={(event) => {
                        event.stopPropagation();
                        void placeImage(key, item.reference!);
                      }}
                    >
                      {placingKey === key
                        ? ui.busy
                        : availability[key]
                          ? ui.episodeData.replaceImage
                          : ui.episodeData.uploadImage}
                    </button>
                  )}
                </article>
              );
            })}
            {!materialAssets.length && (
              <p className="muted">{ui.episodeData.noMaterials}</p>
            )}
          </div>
        )}
      </div>
      {prompt && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            setPromptCopied(false);
            setPrompt(null);
          }}
        >
          <section
            className="modal generation-prompt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generation-prompt-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              aria-label={ui.cancel}
              onClick={() => {
                setPromptCopied(false);
                setPrompt(null);
              }}
            >
              ×
            </button>
            <h2 id="generation-prompt-title">
              {prompt.name} · {ui.episodeData.generationPrompt}
            </h2>
            <pre className="plain-prompt">
              {prompt.text || ui.episodeData.noGenerationPrompt}
            </pre>
            <div className="modal-actions">
              <button
                type="button"
                disabled={!prompt.text}
                onClick={() => {
                  void navigator.clipboard.writeText(prompt.text).then(() => {
                    setPromptCopied(true);
                    window.setTimeout(() => setPromptCopied(false), 1500);
                  });
                }}
              >
                {promptCopied
                  ? ui.episodeData.promptCopied
                  : ui.episodeData.copyPrompt}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPromptCopied(false);
                  setPrompt(null);
                }}
              >
                {ui.confirm}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

export function ShotCast({
  episode,
  shotId,
}: {
  episode: EpisodeData;
  shotId: string;
}) {
  const cast = episode.characters.filter((role) =>
    episode.castByShot[shotId]?.includes(role.id),
  );
  const speech = episode.dialogues.filter((line) => line.shotId === shotId);
  return (
    <div className="shot-cast">
      {!!cast.length && (
        <>
          <span>{ui.episodeData.cast}</span>
          <div className="cast-chips">
            {cast.map((role, i) => (
              <span
                key={`${role.id}-${i}`}
                title={role.voice || ui.episodeData.noVoice}
              >
                {role.name}
                <small>{role.voice ? "♫" : "—"}</small>
              </span>
            ))}
          </div>
        </>
      )}
      {!!speech.length && (
        <div className="shot-dialogue">
          <strong>{ui.episodeData.speech}</strong>
          {speech.map((line, i) => (
            <p key={i}>
              <b>
                {
                  episode.characters.find(
                    (role) => role.id === line.characterId,
                  )?.name
                }
              </b>
              <small>
                {line.delivery} · {line.interval}
              </small>
              <span>{line.text}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
