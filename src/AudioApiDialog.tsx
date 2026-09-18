import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type { AudioApiProfile, AudioSettings } from "./types";

const emptyProfile = (id: string, name: string): AudioApiProfile => ({
  id,
  name,
  type: "autodl",
  submitUrl: "https://autodl.art/api/v1/comfyui/comfyui_workflow/indextts2-v1",
  queryUrl:
    "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}",
  hasAuthorization: false,
});

export default function AudioApiDialog({
  busy,
  onClose,
  onSaved,
}: {
  busy: boolean;
  onClose: () => void;
  onSaved: (settings: AudioSettings) => void;
}) {
  const [draft, setDraft] = useState<AudioSettings>({
    profiles: [],
    activeProfileId: "",
  });
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useMemo(
    () => draft.profiles.find((item) => item.id === draft.activeProfileId),
    [draft],
  );
  const tokenDraft = active ? tokens[active.id] : undefined;
  const hasToken =
    tokenDraft !== undefined
      ? Boolean(tokenDraft.trim())
      : Boolean(active?.hasAuthorization);
  const tokenDisplay = showToken
    ? (tokenDraft ?? "")
    : hasToken
      ? tokenDraft !== undefined
        ? tokenDraft
        : "••••••••••••••••••••••••••••••••"
      : (tokenDraft ?? "");

  useEffect(() => {
    let alive = true;
    void api
      .audioSettings()
      .then((settings) => {
        if (!alive) return;
        if (settings.profiles.length) setDraft(settings);
        else {
          const id = crypto.randomUUID();
          setDraft({
            profiles: [emptyProfile(id, ui.audio.defaultProfile)],
            activeProfileId: id,
          });
        }
        setLoading(false);
      })
      .catch((reason) => {
        if (alive) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const update = (values: Partial<AudioApiProfile>) =>
    setDraft((current) => ({
      ...current,
      profiles: current.profiles.map((item) =>
        item.id === current.activeProfileId ? { ...item, ...values } : item,
      ),
    }));

  const toggleToken = async () => {
    if (showToken) return setShowToken(false);
    if (!active) return;
    if (tokenDraft !== undefined) return setShowToken(true);
    try {
      const value = await api.audioAuthorization(active.id);
      setTokens((current) => ({ ...current, [active.id]: value }));
      setShowToken(true);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const result = await api.setAudioSettings(draft, tokens);
      onSaved(result);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal api-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-api-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="audio-api-title">{ui.audio.apiSettings}</h2>
        {loading ? (
          <p className="muted">{ui.busy}</p>
        ) : (
          <>
            <label>
              {ui.generation.activeProfile}
              <select
                value={draft.activeProfileId}
                disabled={busy || saving}
                onChange={(event) => {
                  setShowToken(false);
                  setDraft((current) => ({
                    ...current,
                    activeProfileId: event.target.value,
                  }));
                }}
              >
                {draft.profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="api-profile-actions">
              <button
                type="button"
                disabled={busy || saving}
                onClick={() => {
                  const id = crypto.randomUUID();
                  setDraft((current) => ({
                    ...current,
                    activeProfileId: id,
                    profiles: [
                      ...current.profiles,
                      emptyProfile(
                        id,
                        `${ui.generation.profileName} ${current.profiles.length + 1}`,
                      ),
                    ],
                  }));
                }}
              >
                {ui.generation.addProfile}
              </button>
              {active && (
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy || saving}
                  onClick={() => {
                    const profiles = draft.profiles.filter(
                      (item) => item.id !== active.id,
                    );
                    setDraft({
                      profiles,
                      activeProfileId: profiles[0]?.id ?? "",
                    });
                    setTokens((current) => {
                      const next = { ...current };
                      delete next[active.id];
                      return next;
                    });
                    setShowToken(false);
                  }}
                >
                  {ui.generation.deleteProfile}
                </button>
              )}
            </div>
            {active ? (
              <>
                <label>
                  {ui.generation.platformType}
                  <select value={active.type} disabled>
                    <option value="autodl">AutoDL</option>
                  </select>
                  <small>{ui.audio.platformHint}</small>
                </label>
                <label>
                  {ui.generation.profileName}
                  <input
                    value={active.name}
                    disabled={busy || saving}
                    required
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </label>
                <label>
                  {ui.generation.submitUrl}
                  <input
                    autoFocus
                    value={active.submitUrl}
                    disabled={busy || saving}
                    required
                    spellCheck={false}
                    onChange={(event) =>
                      update({ submitUrl: event.target.value })
                    }
                  />
                  <small>{ui.audio.submitHint}</small>
                </label>
                <label>
                  {ui.generation.queryUrl}
                  <input
                    value={active.queryUrl}
                    disabled={busy || saving}
                    required
                    spellCheck={false}
                    onChange={(event) =>
                      update({ queryUrl: event.target.value })
                    }
                  />
                  <small>{ui.generation.queryUrlHint}</small>
                </label>
                <div className="api-inline-field">
                  <span>{ui.generation.authorization}</span>
                  <span className="secret-input">
                    <input
                      type={showToken ? "text" : "password"}
                      value={tokenDisplay}
                      readOnly={
                        !showToken && hasToken && tokenDraft === undefined
                      }
                      disabled={busy || saving}
                      onChange={(event) =>
                        setTokens((current) => ({
                          ...current,
                          [active.id]: event.target.value,
                        }))
                      }
                      placeholder={ui.generation.authorizationPlaceholder}
                      autoComplete="new-password"
                    />
                    {hasToken && (
                      <button
                        type="button"
                        disabled={busy || saving}
                        onClick={() => void toggleToken()}
                      >
                        {showToken
                          ? ui.generation.hideToken
                          : ui.generation.showToken}
                      </button>
                    )}
                  </span>
                </div>
                <small className="api-inline-hint">
                  {ui.generation.authorizationHint}
                </small>
              </>
            ) : (
              <p className="muted">{ui.generation.noProfiles}</p>
            )}
          </>
        )}
        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            {ui.cancel}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={
              busy ||
              saving ||
              loading ||
              draft.profiles.some(
                (item) =>
                  !item.name.trim() ||
                  !item.submitUrl.trim() ||
                  !item.queryUrl.trim(),
              )
            }
            onClick={() => void save()}
          >
            {saving ? ui.busy : ui.confirm}
          </button>
        </div>
      </section>
    </div>
  );
}
