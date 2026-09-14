import { useState } from "react";
import type { EpisodeData } from "./types";
import { ui } from "./i18n";

export default function EpisodeOverview({
  episode,
  asset,
}: {
  episode: EpisodeData;
  asset: (
    reference: string,
    onAvailability?: (exists: boolean) => void,
  ) => React.ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<"roles" | "assets">("roles");
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState<{ name: string; text: string } | null>(
    null,
  );
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
    if (!reference || availability[key] === false) setPrompt({ name, text });
  };
  const keyboardClick = (event: React.KeyboardEvent, click: () => void) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      click();
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
                </article>
              );
            })}
            {!materialAssets.length && (
              <p className="muted">{ui.episodeData.noMaterials}</p>
            )}
          </div>
        )}
      </div>
      <p className="episode-source-note">{ui.episodeData.sourceNotes}</p>

      {prompt && (
        <div className="modal-backdrop" onMouseDown={() => setPrompt(null)}>
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
              onClick={() => setPrompt(null)}
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
              <button type="button" onClick={() => setPrompt(null)}>
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
