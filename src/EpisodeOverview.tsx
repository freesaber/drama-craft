import { useEffect, useRef, useState } from "react";
import { api, chooseMedia, desktop, errorMessage } from "./api";
import { indexedGenerationPrompt, parseAssetIndex } from "./assetIndex";
import { formatDialogueColumn } from "./episodeFormat";
import { ui } from "./i18n";
import { isProjectRelativeImage } from "./markdown";
import type { DocumentEntry, EpisodeData, Project } from "./types";

export default function EpisodeOverview({
  episode,
  project,
  document,
  documents,
  source,
  busy = false,
  asset,
  onMediaPlaced,
}: {
  episode: EpisodeData;
  project: Project;
  document: string;
  documents: DocumentEntry[];
  source: string;
  busy?: boolean;
  asset: (
    reference: string,
    onAvailability?: (exists: boolean) => void,
  ) => React.ReactNode;
  onMediaPlaced?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"roles" | "assets" | "dialogues">(
    "roles",
  );
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState<{
    name: string;
    text: string;
    firstDocument?: string;
    loading?: boolean;
    error?: string;
  } | null>(null);
  const promptRequest = useRef(0);
  useEffect(
    () => () => {
      promptRequest.current += 1;
    },
    [project.handle, document],
  );
  const [promptCopied, setPromptCopied] = useState(false);
  const [dialogueCopied, setDialogueCopied] = useState(false);
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
  const closePromptModal = () => {
    promptRequest.current += 1;
    setPromptCopied(false);
    setPrompt(null);
  };
  const openPromptModal = async (
    id: string,
    name: string,
    text: string,
    reference: string | null,
  ) => {
    const request = ++promptRequest.current;
    setPromptCopied(false);
    setPrompt({ name, text, loading: true });
    try {
      const raw = await api.assetIndex(project.handle);
      if (request !== promptRequest.current) return;
      const index = parseAssetIndex(
        raw,
        documents.map((item) => item.path),
      );
      const matches = index.assets.filter(
        (item) => item.id === id && item.name === name,
      );
      if (matches.length !== 1) {
        setPrompt({ name, text });
        return;
      }
      const firstDocument = matches[0].firstDocument;
      if (!documents.some((item) => item.path === firstDocument)) {
        setPrompt({
          name,
          text,
          firstDocument,
          error: ui.episodeData.indexDocumentMissing,
        });
        return;
      }
      const source =
        firstDocument === document
          ? { text: sourceText.current }
          : await api.read(project.handle, firstDocument);
      if (request !== promptRequest.current) return;
      const found = indexedGenerationPrompt(
        index.assets,
        id,
        name,
        reference,
        source.text,
      );
      setPrompt(
        found
          ? { name, text: found.prompt, firstDocument: found.firstDocument }
          : { name, text, firstDocument, error: ui.episodeData.indexMismatch },
      );
    } catch (cause) {
      if (request === promptRequest.current)
        setPrompt({ name, text, error: errorMessage(cause) });
    }
  };
  const sourceText = useRef(source);
  sourceText.current = source;
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
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "dialogues"}
            onClick={() => setActiveTab("dialogues")}
          >
            {ui.episodeData.dialogueTab}
            <span>{episode.dialogues.length}</span>
          </button>
        </div>

        {activeTab === "roles" ? (
          <div role="tabpanel" className="episode-material-row">
            {episode.characters.map((role, index) => {
              const key = `role-${role.id}-${index}`;
              const openPrompt = () =>
                void openPromptModal(
                  role.id,
                  role.name,
                  role.imagePrompt,
                  role.image,
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
        ) : activeTab === "assets" ? (
          <div role="tabpanel" className="episode-material-row">
            {materialAssets.map((item, index) => {
              const key = `asset-${item.id}-${index}`;
              const openPrompt = () =>
                void openPromptModal(
                  item.id,
                  item.name,
                  item.prompt,
                  item.reference,
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
        ) : (
          <div role="tabpanel" className="episode-dialogue-panel">
            {episode.dialogues.length ? (
              <div className="episode-dialogue-table-wrap">
                <table
                  className="episode-dialogue-table"
                  aria-label={ui.episodeData.dialogueTab}
                >
                  <thead>
                    <tr>
                      <th className="episode-dialogue-shot">
                        {ui.episodeData.dialogueShot}
                      </th>
                      <th className="episode-dialogue-role">
                        {ui.episodeData.dialogueRole}
                      </th>
                      <th className="episode-dialogue-line">
                        <span className="episode-dialogue-line-head">
                          {ui.episodeData.dialogueLine}
                          <button
                            type="button"
                            className="episode-dialogue-copy"
                            title={ui.episodeData.copyDialogueColumn}
                            aria-label={ui.episodeData.copyDialogueColumn}
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(
                                  formatDialogueColumn(episode.dialogues),
                                )
                                .then(() => {
                                  setDialogueCopied(true);
                                  window.setTimeout(
                                    () => setDialogueCopied(false),
                                    1500,
                                  );
                                });
                            }}
                          >
                            {dialogueCopied
                              ? ui.episodeData.promptCopied
                              : ui.episodeData.copyPrompt}
                          </button>
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {episode.dialogues.map((line, index) => (
                      <tr key={`${line.shotId}-${line.characterId}-${index}`}>
                        <td className="episode-dialogue-shot">{line.shotId}</td>
                        <td className="episode-dialogue-role">
                          {line.characterName}
                        </td>
                        <td className="episode-dialogue-line">{line.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">{ui.episodeData.noDialogues}</p>
            )}
          </div>
        )}
      </div>
      {prompt && (
        <div className="modal-backdrop" onMouseDown={closePromptModal}>
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
              onClick={closePromptModal}
            >
              ×
            </button>
            <h2 id="generation-prompt-title">
              {prompt.name} · {ui.episodeData.generationPrompt}
            </h2>
            {prompt.firstDocument && (
              <p className="generation-prompt-source">
                {ui.episodeData.firstDefinedIn}：{prompt.firstDocument}
              </p>
            )}
            {prompt.error && (
              <p className="diagnostic" role="alert">
                {prompt.error}
              </p>
            )}
            <pre className="plain-prompt">
              {prompt.loading
                ? ui.episodeData.loadingPrompt
                : prompt.text || ui.episodeData.noGenerationPrompt}
            </pre>
            <div className="modal-actions">
              <button
                type="button"
                disabled={!prompt.text || prompt.loading}
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
              <button type="button" onClick={closePromptModal}>
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
              <span>{line.text}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
