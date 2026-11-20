import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type {
  ApiProfile,
  AudioApiProfile,
  AudioSettings,
  GenerationSettings,
} from "./types";
import {
  API_PLATFORM_TYPES,
  AUTODL_RESOLUTION_PRESETS,
  autodlApiProfile,
  compactResolutionsJson,
  emptyApiProfile,
  fillEmptyAutodlPreset,
  migrateGenerationSettings,
  type AutodlPreset,
} from "./videoWorkflows";

type ProfileList<Profile> = { profiles: Profile[]; activeProfileId: string };
type EditorTarget<Profile> = {
  action: "add" | "edit" | "delete";
  profile: Profile;
};

interface DialogProps<Settings> {
  busy: boolean;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

const loadVideoSettings = async () =>
  migrateGenerationSettings(await api.generationSettings());

export function VideoApiDialog(props: DialogProps<GenerationSettings>) {
  return (
    <ApiSettingsDialog<ApiProfile, GenerationSettings>
      {...props}
      title={ui.generation.apiSettings}
      submitHint={ui.generation.submitUrlHint}
      load={loadVideoSettings}
      save={api.setGenerationSettings}
      readToken={api.generationAuthorization}
      create={emptyApiProfile}
      createPreset={autodlApiProfile}
    />
  );
}

function emptyAudioProfile(id: string, name: string): AudioApiProfile {
  return {
    id,
    name,
    type: "autodl",
    submitUrl:
      "https://autodl.art/api/v1/comfyui/comfyui_workflow/indextts2-v1",
    queryUrl:
      "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}",
    hasAuthorization: false,
  };
}

export function AudioApiDialog(props: DialogProps<AudioSettings>) {
  return (
    <ApiSettingsDialog<AudioApiProfile, AudioSettings>
      {...props}
      title={ui.audio.apiSettings}
      submitHint={ui.audio.submitHint}
      load={api.audioSettings}
      save={api.setAudioSettings}
      readToken={api.audioAuthorization}
      create={emptyAudioProfile}
    />
  );
}

function ApiSettingsDialog<
  Profile extends AudioApiProfile,
  Settings extends ProfileList<Profile>,
>({
  busy,
  onClose,
  onSaved,
  title,
  submitHint,
  load,
  save,
  readToken,
  create,
  createPreset,
}: DialogProps<Settings> & {
  title: string;
  submitHint: string;
  load: () => Promise<Settings>;
  save: (
    settings: Settings,
    tokens: Record<string, string>,
  ) => Promise<Settings>;
  readToken: (id: string) => Promise<string>;
  create: (id: string, name: string) => Profile;
  createPreset?: (id: string, preset: AutodlPreset) => Profile;
}) {
  const titleId = useId();
  const deleteTitleId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [target, setTarget] = useState<EditorTarget<Profile> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const disabled = busy || saving;

  useEffect(() => {
    let alive = true;
    void load()
      .then((value) => {
        if (alive) setSettings(value);
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason));
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const loaded = settings !== null;
  useEffect(() => {
    if (target || !loaded) return;
    const button = opener.current;
    if (button?.isConnected) button.focus();
    else addButton.current?.focus();
    opener.current = null;
  }, [target, loaded]);

  const open = (next: EditorTarget<Profile>, button: HTMLElement) => {
    opener.current = button;
    setError("");
    setTarget(next);
  };
  const closeChild = () => {
    if (saving) return;
    setTarget(null);
    setError("");
  };

  const persist = async (
    next: Settings,
    tokens: Record<string, string> = {},
  ) => {
    if (disabled) return;
    setSaving(true);
    setError("");
    try {
      const saved = await save(next, tokens);
      setSettings(saved);
      setTarget(null);
      onSaved(saved);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const deletion =
    target?.action === "delete" && settings
      ? settings.profiles.filter((profile) => profile.id !== target.profile.id)
      : null;
  const deletingDefault =
    target?.action === "delete" &&
    target.profile.id === settings?.activeProfileId;

  return (
    <>
      <div
        className="modal-backdrop"
        onClick={() => {
          if (!saving && !target) onClose();
        }}
      >
        <section
          className="modal api-list-modal"
          role="dialog"
          aria-modal={!target}
          aria-labelledby={titleId}
          inert={target !== null}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !saving) onClose();
          }}
        >
          <header className="api-list-header">
            <h2 id={titleId}>{title}</h2>
            <button
              ref={addButton}
              type="button"
              className="primary-button"
              disabled={disabled || !settings}
              onClick={(event) =>
                open(
                  { action: "add", profile: create(crypto.randomUUID(), "") },
                  event.currentTarget,
                )
              }
            >
              {ui.apiProfiles.add}
            </button>
          </header>
          <p className="api-list-hint">{ui.apiProfiles.defaultHint}</p>
          {settings?.profiles.length ? (
            <div className="api-list-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{ui.apiProfiles.defaultColumn}</th>
                    <th scope="col">{ui.generation.profileName}</th>
                    <th scope="col">{ui.generation.platformType}</th>
                    <th scope="col">{ui.apiProfiles.tokenColumn}</th>
                    <th scope="col">{ui.apiProfiles.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.profiles.map((profile) => (
                    <tr key={profile.id}>
                      <td>
                        <input
                          type="radio"
                          name={titleId}
                          aria-label={ui.apiProfiles.setDefault(profile.name)}
                          checked={profile.id === settings.activeProfileId}
                          disabled={disabled}
                          onChange={() =>
                            void persist({
                              ...settings,
                              activeProfileId: profile.id,
                            })
                          }
                        />
                      </td>
                      <th scope="row">{profile.name}</th>
                      <td>
                        {API_PLATFORM_TYPES.find(
                          (item) => item.id === profile.type,
                        )?.label ?? profile.type}
                      </td>
                      <td
                        className={
                          profile.hasAuthorization ? "token-saved" : "muted"
                        }
                      >
                        {profile.hasAuthorization
                          ? ui.apiProfiles.tokenSaved
                          : ui.apiProfiles.tokenMissing}
                      </td>
                      <td>
                        <div className="api-profile-actions">
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={(event) =>
                              open(
                                { action: "edit", profile },
                                event.currentTarget,
                              )
                            }
                          >
                            {ui.apiProfiles.edit}
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={disabled}
                            onClick={(event) =>
                              open(
                                { action: "delete", profile },
                                event.currentTarget,
                              )
                            }
                          >
                            {ui.apiProfiles.delete}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">
              {settings ? ui.generation.noProfiles : !error && ui.busy}
            </p>
          )}
          {!target && error && (
            <p className="warning-text" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" disabled={saving} onClick={onClose}>
              {saving ? ui.busy : ui.apiProfiles.close}
            </button>
          </div>
        </section>
      </div>
      {settings && target && target.action !== "delete" && (
        <ApiProfileEditor
          target={target}
          disabled={disabled}
          saving={saving}
          error={error}
          submitHint={submitHint}
          readToken={readToken}
          createPreset={createPreset}
          onClose={closeChild}
          onSave={(profile, token) =>
            void persist(
              {
                ...settings,
                profiles:
                  target.action === "add"
                    ? [...settings.profiles, profile]
                    : settings.profiles.map((item) =>
                        item.id === profile.id ? profile : item,
                      ),
                activeProfileId: settings.activeProfileId || profile.id,
              },
              token === undefined ? {} : { [profile.id]: token },
            )
          }
        />
      )}
      {settings && target?.action === "delete" && deletion && (
        <div className="modal-backdrop api-child-backdrop" onClick={closeChild}>
          <section
            className="modal confirmation-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={deleteTitleId}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeChild();
            }}
          >
            <h2 id={deleteTitleId}>{ui.apiProfiles.deleteTitle}</h2>
            <p>{ui.apiProfiles.deleteHint(target.profile.name)}</p>
            {deletingDefault && deletion[0] && (
              <p>{ui.apiProfiles.replacementHint(deletion[0].name)}</p>
            )}
            {error && (
              <p className="warning-text" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                autoFocus
                disabled={saving}
                onClick={closeChild}
              >
                {ui.cancel}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={disabled}
                onClick={() =>
                  void persist({
                    ...settings,
                    profiles: deletion,
                    activeProfileId: deletingDefault
                      ? (deletion[0]?.id ?? "")
                      : settings.activeProfileId,
                  })
                }
              >
                {saving ? ui.busy : ui.apiProfiles.delete}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function isVideoProfile(profile: AudioApiProfile): profile is ApiProfile {
  return "resolutions" in profile;
}

function ApiProfileEditor<Profile extends AudioApiProfile>({
  target,
  disabled,
  saving,
  error,
  submitHint,
  readToken,
  createPreset,
  onClose,
  onSave,
}: {
  target: EditorTarget<Profile>;
  disabled: boolean;
  saving: boolean;
  error: string;
  submitHint: string;
  readToken: (id: string) => Promise<string>;
  createPreset?: (id: string, preset: AutodlPreset) => Profile;
  onClose: () => void;
  onSave: (profile: Profile, token: string | undefined) => void;
}) {
  const titleId = useId();
  const tokenId = useId();
  const [profile, setProfile] = useState<Profile>(() =>
    isVideoProfile(target.profile)
      ? {
          ...target.profile,
          resolutions: compactResolutionsJson(target.profile.resolutions),
        }
      : target.profile,
  );
  const [tokenDraft, setTokenDraft] = useState<string>();
  const [loadedToken, setLoadedToken] = useState<string>();
  const [showToken, setShowToken] = useState(false);
  const [readingToken, setReadingToken] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const token = tokenDraft ?? loadedToken;
  const tokenLocked = profile.hasAuthorization && token === undefined;
  const video = isVideoProfile(profile) ? profile : null;
  const adding = target.action === "add";

  const toggleToken = async () => {
    if (showToken) {
      setShowToken(false);
      return;
    }
    if (tokenLocked) {
      setReadingToken(true);
      setTokenError("");
      try {
        setLoadedToken(await readToken(profile.id));
      } catch (reason) {
        setTokenError(errorMessage(reason));
        return;
      } finally {
        setReadingToken(false);
      }
    }
    setShowToken(true);
  };

  const fillVideoDefaults = () => {
    if (adding && video)
      setProfile({ ...profile, ...fillEmptyAutodlPreset(video) });
  };

  return (
    <div className="modal-backdrop api-child-backdrop" onClick={onClose}>
      <section
        className="modal api-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <h2 id={titleId}>
          {adding ? ui.apiProfiles.add : ui.apiProfiles.editTitle}
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(profile, tokenDraft);
          }}
        >
          {adding && createPreset && (
            <label>
              {ui.generation.addPreset}
              <select
                value=""
                disabled={disabled}
                onChange={(event) => {
                  const preset = AUTODL_RESOLUTION_PRESETS.find(
                    (item) => item.id === event.target.value,
                  );
                  if (preset) setProfile(createPreset(profile.id, preset));
                }}
              >
                <option value="">{ui.generation.choosePreset}</option>
                {AUTODL_RESOLUTION_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {ui.generation.profileName}
            <input
              autoFocus
              value={profile.name}
              required
              disabled={disabled}
              onChange={(event) =>
                setProfile({ ...profile, name: event.target.value })
              }
              onBlur={fillVideoDefaults}
            />
          </label>
          <label>
            {ui.generation.submitUrl}
            <input
              value={profile.submitUrl}
              required
              disabled={disabled}
              spellCheck={false}
              placeholder={ui.generation.submitUrlPlaceholder}
              onChange={(event) =>
                setProfile({ ...profile, submitUrl: event.target.value })
              }
              onBlur={fillVideoDefaults}
            />
            <small>{submitHint}</small>
          </label>
          <label>
            {ui.generation.queryUrl}
            <input
              value={profile.queryUrl}
              required
              disabled={disabled}
              spellCheck={false}
              placeholder={ui.generation.queryUrlPlaceholder}
              onChange={(event) =>
                setProfile({ ...profile, queryUrl: event.target.value })
              }
            />
            <small>{ui.generation.queryUrlHint}</small>
          </label>
          {video && (
            <div className="api-editor-parameters">
              <label>
                {ui.generation.resolutions}
                <input
                  value={video.resolutions}
                  required
                  disabled={disabled}
                  spellCheck={false}
                  placeholder={ui.generation.resolutionsPlaceholder}
                  onChange={(event) =>
                    setProfile({ ...profile, resolutions: event.target.value })
                  }
                />
              </label>
              <label>
                {ui.generation.defaultSeed}
                <input
                  value={video.defaultSeed}
                  inputMode="numeric"
                  disabled={disabled}
                  placeholder={ui.generation.defaultSeedPlaceholder}
                  onChange={(event) =>
                    setProfile({
                      ...profile,
                      defaultSeed: event.target.value.replace(/[^0-9]/g, ""),
                    })
                  }
                />
              </label>
            </div>
          )}
          <label htmlFor={tokenId}>{ui.generation.authorization}</label>
          <div className="secret-input">
            <input
              id={tokenId}
              type={showToken ? "text" : "password"}
              value={tokenLocked ? "••••••••••••••••" : (token ?? "")}
              readOnly={tokenLocked}
              disabled={disabled || readingToken}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder={ui.generation.authorizationPlaceholder}
              autoComplete="new-password"
            />
            <button
              type="button"
              disabled={disabled || readingToken}
              onClick={() => void toggleToken()}
            >
              {showToken ? ui.generation.hideToken : ui.generation.showToken}
            </button>
          </div>
          <small className="api-inline-hint">
            {ui.generation.authorizationHint}
          </small>
          {(error || tokenError) && (
            <p className="warning-text" role="alert">
              {error || tokenError}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" disabled={saving} onClick={onClose}>
              {ui.cancel}
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={
                disabled ||
                readingToken ||
                !profile.name.trim() ||
                !profile.submitUrl.trim() ||
                !profile.queryUrl.trim() ||
                (video !== null && !video.resolutions.trim())
              }
            >
              {saving ? ui.busy : ui.save}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
