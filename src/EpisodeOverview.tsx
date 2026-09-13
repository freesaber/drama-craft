import { useState } from "react";
import type { EpisodeData } from "./types";
import { ui } from "./i18n";

export default function EpisodeOverview({
  episode,
  asset,
  source,
}: {
  episode: EpisodeData;
  asset: (reference: string) => React.ReactNode;
  source: () => void;
}) {
  const [rolesOpen, setRolesOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const materialAssets = episode.assets.filter(
    (item) =>
      !episode.characters.some(
        (role) => role.image && role.image === item.reference,
      ),
  );
  return (
    <section className="episode-overview">
      <div className="board-section-heading">
        <strong>{episode.title}</strong>
        <span>
          {episode.format === "v1" ? ui.episodeData.v1 : ui.episodeData.legacy}
        </span>
        <button onClick={source}>{ui.episodeData.edit}</button>
      </div>
      <p className="episode-summary">
        {episode.summary || ui.episodeData.noSummary}
      </p>
      <details onToggle={(event) => setRolesOpen(event.currentTarget.open)}>
        <summary>
          {ui.episodeData.roles} <span>{episode.characters.length}</span>
        </summary>
        <div className="character-grid">
          {episode.characters.map((role, index) => (
            <article
              className="character-card"
              key={`${role.id}-${index}`}
              data-character-id={role.id}
            >
              <header>
                <code>{role.id}</code>
                <strong>{role.name}</strong>
              </header>
              {role.description && <p>{role.description}</p>}
              <div className="character-portrait">
                {rolesOpen && role.image ? (
                  asset(role.image)
                ) : (
                  <span className="muted">{ui.episodeData.noImage}</span>
                )}
              </div>
              <div className="character-voice">
                <strong>{ui.episodeData.voice}</strong>
                <p>{role.voiceStatus || ui.episodeData.unverified}</p>
                {rolesOpen && role.voice ? (
                  asset(role.voice)
                ) : (
                  <span className="muted">{ui.episodeData.noVoice}</span>
                )}
              </div>
              <p className="character-usage">{role.shots.join(" · ")}</p>
            </article>
          ))}
        </div>
      </details>
      <details onToggle={(event) => setAssetsOpen(event.currentTarget.open)}>
        <summary>
          {ui.episodeData.assets} <span>{materialAssets.length}</span>
        </summary>
        <div className="reference-grid">
          {materialAssets.map((item, index) => (
            <article className="character-card" key={`${item.id}-${index}`}>
              <header>
                <code>{item.id}</code>
                <strong>{item.name}</strong>
                <span>{item.kind}</span>
              </header>
              {assetsOpen && item.reference && asset(item.reference)}
              {item.note && <p>{item.note}</p>}
              {item.prompt && (
                <details>
                  <summary>{ui.board.framePrompt}</summary>
                  <p className="plain-prompt">{item.prompt}</p>
                </details>
              )}
              <p className="character-usage">{item.shots.join(" · ")}</p>
            </article>
          ))}
        </div>
      </details>
      <p className="episode-source-note">{ui.episodeData.sourceNotes}</p>
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
                title={
                  role.voice
                    ? `${role.voice} · ${role.voiceStatus}`
                    : ui.episodeData.noVoice
                }
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
