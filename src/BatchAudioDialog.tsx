import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type { Project, Storyboard } from "./types";

const referenceName = (value: string) => value.split(/[/\\]/).at(-1) || value;
const emotionFields = [
  ["happy", "开心"],
  ["calm", "平静"],
  ["sad", "悲伤"],
  ["angry", "愤怒"],
  ["afraid", "恐惧"],
  ["disgusted", "厌恶"],
  ["melancholic", "忧郁"],
] as const;
type EmotionKey = (typeof emotionFields)[number][0];

export default function BatchAudioDialog({
  project,
  document,
  board,
  busy,
  onClose,
  onCreated,
}: {
  project: Project;
  document: string;
  board: Storyboard;
  busy: boolean;
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const groups = useMemo(
    () =>
      board.episode.characters
        .map((role) => ({
          role,
          lines: board.episode.dialogues.filter(
            (line) => line.characterId === role.id && line.text.trim(),
          ),
        }))
        .filter((group) => group.lines.length),
    [board],
  );
  const available = groups.filter((group) => group.role.voice);
  const [selected, setSelected] = useState(
    () => new Set(available.map((group) => group.role.id)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [controlMethod, setControlMethod] = useState("与音色参考音频相同");
  const [randomEmotion, setRandomEmotion] = useState(false);
  const [emotions, setEmotions] = useState<Record<EmotionKey, number>>({
    happy: 0.5,
    calm: 0.3,
    sad: 0,
    angry: 0,
    afraid: 0,
    disgusted: 0,
    melancholic: 0,
  });
  const allRef = useRef<HTMLInputElement>(null);
  const allSelected =
    available.length > 0 &&
    available.every((group) => selected.has(group.role.id));
  const someSelected = available.some((group) => selected.has(group.role.id));
  useEffect(() => {
    if (allRef.current)
      allRef.current.indeterminate = someSelected && !allSelected;
  }, [allSelected, someSelected]);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const submit = async () => {
    const items = available.filter((group) => selected.has(group.role.id));
    if (!items.length) return;
    setSubmitting(true);
    setError("");
    try {
      const settings = await api.audioSettings();
      const profile = settings.profiles.find(
        (item) => item.id === settings.activeProfileId,
      );
      if (
        !profile ||
        !profile.hasAuthorization ||
        !profile.submitUrl.trim() ||
        !profile.queryUrl.trim()
      )
        throw new Error(ui.audio.notConfigured);
      await api.createBatchJob(project.handle, {
        jobType: "audio",
        name: `${ui.batch.typeAudio} · ${document.split(/[/\\]/).at(-1) ?? document} · ${items.length}`,
        document,
        delayHours: 0,
        items: items.map(({ role, lines }) => ({
          shotId: role.id,
          shotTitle: role.name,
          prompt: lines.map((line) => line.text.trim()).join("\n"),
          duration: 1,
          resolution: JSON.stringify({
            control_method: controlMethod,
            random: randomEmotion,
            ...emotions,
          }),
          seed: null,
          imageRefs: [],
          audioRefs: [role.voice!],
        })),
      });
      onCreated(ui.audio.created);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal batch-modal audio-batch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-audio-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="batch-audio-title">{ui.audio.batchTitle}</h2>
        <p className="muted">{ui.audio.batchHint}</p>
        <details className="audio-options">
          <summary>{ui.audio.options}</summary>
          <div className="audio-options-row">
            <label>
              {ui.audio.controlMethod}
              <select
                value={controlMethod}
                disabled={busy || submitting}
                onChange={(event) => setControlMethod(event.target.value)}
              >
                <option value="与音色参考音频相同">与音色参考音频相同</option>
                <option value="使用情感参考音频">使用情感参考音频</option>
                <option value="使用情感向量控制">使用情感向量控制</option>
              </select>
            </label>
            <label className="audio-random-option">
              <input
                type="checkbox"
                checked={randomEmotion}
                disabled={busy || submitting}
                onChange={(event) => setRandomEmotion(event.target.checked)}
              />
              {ui.audio.randomEmotion}
            </label>
          </div>
          {controlMethod === "使用情感参考音频" && (
            <p className="muted">{ui.audio.referenceEmotionHint}</p>
          )}
          {controlMethod === "使用情感向量控制" && !randomEmotion && (
            <div className="audio-emotion-grid">
              {emotionFields.map(([key, label]) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min="0"
                    max="1.4"
                    step="0.1"
                    value={emotions[key]}
                    disabled={busy || submitting}
                    onChange={(event) =>
                      setEmotions((current) => ({
                        ...current,
                        [key]: Math.min(
                          1.4,
                          Math.max(0, Number(event.target.value) || 0),
                        ),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          )}
        </details>
        {groups.length ? (
          <div className="batch-shot-table-wrap">
            <table className="batch-shot-table is-selectable">
              <thead>
                <tr>
                  <th className="batch-shot-check">
                    <input
                      ref={allRef}
                      type="checkbox"
                      checked={allSelected}
                      disabled={busy || submitting || !available.length}
                      aria-label={ui.batch.selectAll}
                      onChange={() =>
                        setSelected(
                          allSelected
                            ? new Set()
                            : new Set(available.map((group) => group.role.id)),
                        )
                      }
                    />
                  </th>
                  <th className="audio-character-column">
                    {ui.audio.character}
                  </th>
                  <th className="audio-lines-column">{ui.audio.lines}</th>
                  <th className="audio-voice-column">{ui.audio.voice}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ role, lines }) => {
                  const enabled = Boolean(role.voice);
                  const checked = enabled && selected.has(role.id);
                  return (
                    <tr
                      key={role.id}
                      className={checked ? "is-selected" : ""}
                      onClick={() =>
                        enabled && !busy && !submitting && toggle(role.id)
                      }
                    >
                      <td className="batch-shot-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!enabled || busy || submitting}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggle(role.id)}
                        />
                      </td>
                      <td className="audio-character-column">
                        <strong>{role.name}</strong>
                        <small className="audio-role-id">{role.id}</small>
                      </td>
                      <td className="audio-lines-column">
                        <div className="audio-dialogue-lines">
                          {lines.map((line, index) => (
                            <div key={`${line.shotId}-${index}`}>
                              <code>{line.shotId}</code>
                              <span>{line.text}</span>
                            </div>
                          ))}
                        </div>
                        <small>{lines.length} 句</small>
                      </td>
                      <td
                        className={`audio-voice-column${!enabled ? " generation-error" : ""}`}
                      >
                        {role.voice ? (
                          <span
                            className="audio-voice-reference"
                            title={role.voice}
                          >
                            {referenceName(role.voice)}
                          </span>
                        ) : (
                          ui.audio.missingVoice
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{ui.audio.empty}</p>
        )}
        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="muted">{ui.audio.selected(selected.size)}</span>
          <button type="button" disabled={submitting} onClick={onClose}>
            {ui.cancel}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || submitting || !selected.size}
            onClick={() => void submit()}
          >
            {submitting ? ui.busy : ui.audio.confirm}
          </button>
        </div>
      </section>
    </div>
  );
}
