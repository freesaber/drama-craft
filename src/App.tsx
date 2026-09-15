import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, chooseDirectory, desktop, errorMessage } from "./api";
import { isOverviewDocument, sortDocuments } from "./markdown";
import { ui } from "./i18n";
import Storyboard from "./BoardView";
import { applySourcePatch, fieldPatch, parseStoryboard } from "./storyboard";
import { useUnsavedChanges } from "./useUnsavedChanges";
import type {
  Candidate,
  DocumentEntry,
  GenerationSettings,
  Project,
  Recent,
  Snapshot,
  SourcePatch,
} from "./types";

export default function App() {
  const { ask: discardChanges, dialog: unsavedDialog } = useUnsavedChanges();
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [path, setPath] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [mode, setMode] = useState<"board" | "source">("board");
  const [activeShot, setActiveShot] = useState(0);
  const pendingJump = useRef<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generationSettings, setGenerationSettings] =
    useState<GenerationSettings>({
      profiles: [],
      activeProfileId: "",
      defaultResolution: "480p横",
    });
  const [apiDraft, setApiDraft] = useState<GenerationSettings>({
    profiles: [],
    activeProfileId: "",
    defaultResolution: "480p横",
  });
  const [apiAuthorizations, setApiAuthorizations] = useState<
    Record<string, string>
  >({});
  const [showApiToken, setShowApiToken] = useState(false);
  const activeApi = apiDraft.profiles.find(
    (profile) => profile.id === apiDraft.activeProfileId,
  );
  const updateApi = (
    values: Partial<Pick<import("./types").ApiProfile, "name" | "baseUrl">>,
  ) =>
    setApiDraft((draft) => ({
      ...draft,
      profiles: draft.profiles.map((profile) =>
        profile.id === draft.activeProfileId
          ? { ...profile, ...values }
          : profile,
      ),
    }));
  const addApi = () => {
    const id = crypto.randomUUID();
    setApiDraft((draft) => ({
      ...draft,
      activeProfileId: id,
      profiles: [
        ...draft.profiles,
        {
          id,
          name: `${ui.generation.profileName} ${draft.profiles.length + 1}`,
          baseUrl: "https://autodl.art",
          hasAuthorization: false,
        },
      ],
    }));
  };
  const [modal, setModal] = useState<
    "project" | "open" | "libraries" | "api" | null
  >(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [characterDirectory, setCharacterDirectory] = useState("");
  const [voiceDirectory, setVoiceDirectory] = useState("");
  const [defaultVoiceDirectory, setDefaultVoiceDirectory] = useState("");
  const [pendingProject, setPendingProject] = useState("");
  const [candidates, setCandidates] = useState<{
    root: string;
    list: Candidate[];
  } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = snapshot !== null && text !== snapshot.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const board = useMemo(() => parseStoryboard(text), [text]);
  const textRef = useRef(text);
  textRef.current = text;
  const run = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  const loadPreferences = useCallback(async () => {
    const prefs = await api.preferences();
    setRecent(prefs.recent);
  }, []);
  useEffect(() => {
    if (desktop) {
      void loadPreferences().catch((e) => setError(errorMessage(e)));
      void api
        .defaultVoiceDirectory()
        .then(setDefaultVoiceDirectory)
        .catch((e) => setError(errorMessage(e)));
      void api
        .generationSettings()
        .then(setGenerationSettings)
        .catch((e) => setError(errorMessage(e)));
    }
  }, [loadPreferences]);
  const replaceDocument = (nextPath: string, next: Snapshot) => {
    if (nextPath !== path) {
      setMode("board");
      setActiveShot(0);
    }
    setPath(nextPath);
    setSnapshot(next);
    setText(next.text);
    setConflict(false);
  };
  const scan = async (current: Project) => {
    const result = await api.scan(current.handle);
    const sorted = sortDocuments(result.documents);
    setDocuments(sorted);
    if (result.warnings.length) setNotice(result.warnings.join("\n"));
    return sorted;
  };
  const installProject = async (next: Project) => {
    if (project) await api.close(project.handle);
    setProject(next);
    setMode("board");
    setActiveShot(0);
    setPath("");
    setSnapshot(null);
    setText("");
    setConflict(false);
    setNotice(next.warning ?? "");
    setCandidates(null);
    setModal(null);
    const docs = await scan(next);
    if (docs.length)
      replaceDocument(docs[0].path, await api.read(next.handle, docs[0].path));
    await loadPreferences();
  };
  const openReadyProject = async (selected: string) => {
    try {
      await installProject(await api.open(selected));
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        e.code === "project_setup"
      ) {
        const voices =
          defaultVoiceDirectory || (await api.defaultVoiceDirectory());
        setDefaultVoiceDirectory(voices);
        setPendingProject(selected);
        setCharacterDirectory("");
        setVoiceDirectory(voices);
        setCandidates(null);
        setModal("libraries");
        return;
      }
      throw e;
    }
  };
  const openPath = (selected: string, inspect = true) =>
    run(async () => {
      if (dirty && !(await discardChanges())) return;
      if (inspect) {
        const list = await api.inspect(selected);
        if (list.length) {
          setCandidates({ root: selected, list });
          return;
        }
      }
      await openReadyProject(selected);
    });
  const openDirectory = () =>
    run(async () => {
      if (dirty && !(await discardChanges())) return;
      setParent("");
      setModal("open");
    });
  const selectDocument = (next: string) =>
    run(async () => {
      if (!project || next === path) return;
      if (dirty && !(await discardChanges())) return;
      replaceDocument(next, await api.read(project.handle, next));
      setNotice("");
    });
  const save = () =>
    run(async () => {
      if (!project || !snapshot || !dirty) return;
      try {
        replaceDocument(
          path,
          await api.save(project.handle, path, text, snapshot.hash),
        );
        setNotice(ui.saved);
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && e.code === "conflict")
          setConflict(true);
        throw e;
      }
    });
  const refresh = (automatic = false) =>
    run(async () => {
      if (!project) return;
      await scan(project);
      setRefreshKey((key) => key + 1);
      if (!path || !snapshot) return;
      try {
        const disk = await api.read(project.handle, path);
        if (disk.hash !== snapshot.hash) {
          if (dirty) {
            setConflict(true);
          } else {
            replaceDocument(path, disk);
            setNotice(ui.externalReloaded);
          }
        } else if (!automatic) setNotice(ui.saved);
      } catch (e) {
        if (dirty) setConflict(true);
        throw e;
      }
    });
  const callbacks = useRef({ save, refresh });
  callbacks.current = { save, refresh };
  useEffect(() => {
    const focus = () => {
      if (!busyRef.current) void callbacks.current.refresh(true);
    };
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void callbacks.current.save();
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("focus", focus);
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", unload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (desktop)
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (dirtyRef.current || busyRef.current) {
            event.preventDefault();
            if (busyRef.current) return;
            // Prevent the DOM unload handler from asking a second time.
            busyRef.current = true;
            try {
              if (await discardChanges()) {
                dirtyRef.current = false;
                await getCurrentWindow().destroy();
              }
            } finally {
              busyRef.current = false;
            }
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch((e) => setError(errorMessage(e)));
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("focus", focus);
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", unload);
    };
  }, [discardChanges]);
  const home = () =>
    run(async () => {
      if (dirty && !(await discardChanges())) return;
      if (project) await api.close(project.handle);
      setProject(null);
      setSnapshot(null);
      setText("");
      setPath("");
      setDocuments([]);
      setNotice("");
      setConflict(false);
    });
  const reload = () =>
    run(async () => {
      if (!project || (dirty && !(await discardChanges()))) return;
      replaceDocument(path, await api.read(project.handle, path));
    });
  const submitModal = () =>
    run(async () => {
      if (modal === "api") {
        const settings = await api.setGenerationSettings(
          apiDraft,
          apiAuthorizations,
        );
        setGenerationSettings(settings);
        setApiAuthorizations({});
        setModal(null);
        setNotice(ui.generation.settingsSaved);
      } else if (modal === "open") {
        if (!parent.trim()) return;
        const list = await api.inspect(parent.trim());
        if (list.length) {
          setModal(null);
          setCandidates({ root: parent.trim(), list });
          return;
        }
        await openReadyProject(parent.trim());
      } else if (modal === "project") {
        if (!parent || !name.trim() || !voiceDirectory.trim()) return;
        const created = await api.create(
          parent,
          name.trim(),
          characterDirectory.trim() || undefined,
          voiceDirectory.trim(),
        );
        await api.close(created.handle);
        await loadPreferences();
        setModal(null);
        setNotice(ui.projectCreated);
      } else if (modal === "libraries") {
        if (!pendingProject || !voiceDirectory.trim()) return;
        await installProject(
          await api.open(
            pendingProject,
            characterDirectory.trim() || undefined,
            voiceDirectory.trim(),
          ),
        );
        setPendingProject("");
      }
    });
  const jumpEditor = (offset: number) => {
    const area = editor.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(offset, offset);
    const lines = text.slice(0, offset).split("\n").length;
    area.scrollTop = Math.max(0, (lines - 3) * 24);
  };
  useEffect(() => {
    if (pendingJump.current === null) return;
    const offset = pendingJump.current;
    pendingJump.current = null;
    if (mode === "source") jumpEditor(offset);
    else
      document
        .getElementById(`shot-card-${activeShot}`)
        ?.scrollIntoView({ block: "start" });
  }, [mode, activeShot, path, text]);
  const jump = (offset: number) => {
    const index = board.cards.findIndex((card) => card.offset === offset);
    if (index >= 0) setActiveShot(index);
    if (mode === "source") jumpEditor(offset);
    else
      document
        .getElementById(`shot-card-${index}`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const showSource = (offset: number) => {
    pendingJump.current = offset;
    setMode("source");
    if (mode === "source") jumpEditor(offset);
  };
  const apply = (patch: SourcePatch, nextIndex?: number) => {
    try {
      const next = applySourcePatch(textRef.current, patch);
      textRef.current = next;
      setText(next);
      if (nextIndex !== undefined) {
        setActiveShot(nextIndex);
        pendingJump.current = 0;
      }
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const configureGeneration = () => {
    setApiDraft(generationSettings);
    setApiAuthorizations({});
    setShowApiToken(false);
    if (!generationSettings.profiles.length) {
      const id = crypto.randomUUID();
      setApiDraft({
        activeProfileId: id,
        defaultResolution: generationSettings.defaultResolution,
        profiles: [
          {
            id,
            name: ui.generation.defaultProfile,
            baseUrl: "https://autodl.art",
            hasAuthorization: false,
          },
        ],
      });
    }
    setModal("api");
  };
  const useGeneratedVideo = async (index: number, reference: string) => {
    if (!project || !snapshot) throw new Error(ui.generation.noDocument);
    if (snapshot.readonly) throw new Error(ui.readonly);
    if (busyRef.current) throw new Error(ui.busy);
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const current = parseStoryboard(textRef.current);
      const card = current.cards[index];
      if (!card) throw new Error(ui.generation.shotChanged);
      const nextText = applySourcePatch(
        textRef.current,
        fieldPatch(current, card.fields.videoFile, reference),
      );
      textRef.current = nextText;
      setText(nextText);
      const saved = await api.save(
        project.handle,
        path,
        nextText,
        snapshot.hash,
      );
      replaceDocument(path, saved);
      setRefreshKey((key) => key + 1);
      setNotice(ui.generation.videoApplied);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "conflict")
        setConflict(true);
      setError(errorMessage(e));
      throw e;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => void home()}
          disabled={busy}
          aria-label={ui.home}
        >
          <span className="brand-mark">剧</span>
          <strong>
            DramaCraft<span>{ui.brand}</span>
          </strong>
        </button>
        <div className="breadcrumb">
          {project ? (
            <>
              <span>{ui.workbench}</span>
              <b>/</b>
              <strong>{project.metadata.name}</strong>
            </>
          ) : (
            <span>{ui.workbench}</span>
          )}
        </div>
      </header>
      {!desktop && <div className="banner neutral">{ui.browser}</div>}
      {error && (
        <div role="alert" className="banner error">
          {error}
          <button onClick={() => setError("")} aria-label="关闭错误">
            ×
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="banner neutral">
          {notice}
          <button onClick={() => setNotice("")} aria-label="关闭通知">
            ×
          </button>
        </div>
      )}
      {!project ? (
        <main className="home-page">
          <div className="home-eyebrow">DRAMACRAFT / LOCAL STUDIO</div>
          <h1>{ui.tagline}</h1>
          <p className="home-intro">{ui.intro}</p>
          <div className="start-actions">
            <button
              className="start-card primary-card"
              disabled={!desktop || busy}
              onClick={() => {
                void run(async () => {
                  const voices =
                    defaultVoiceDirectory ||
                    (await api.defaultVoiceDirectory());
                  setDefaultVoiceDirectory(voices);
                  setName("");
                  setParent("");
                  setCharacterDirectory("");
                  setVoiceDirectory(voices);
                  setModal("project");
                });
              }}
            >
              <span className="card-icon">＋</span>
              <strong>{ui.create}</strong>
              <p>{ui.createHint}</p>
              <span className="card-arrow">↗</span>
            </button>
            <button
              className="start-card"
              disabled={!desktop || busy}
              onClick={() => void openDirectory()}
            >
              <span className="card-icon">▱</span>
              <strong>{ui.open}</strong>
              <p>{ui.openHint}</p>
              <span className="card-arrow">↗</span>
            </button>
          </div>
          <section className="recent-section">
            <div className="section-heading">
              <h2>{ui.recent}</h2>
              <span>{recent.length.toString().padStart(2, "0")}</span>
            </div>
            {recent.length ? (
              recent.map((item) => (
                <div className="recent-project" key={item.path}>
                  <button
                    className="recent-project-main"
                    disabled={busy}
                    onClick={() => void openPath(item.path)}
                  >
                    <span className="project-icon">▤</span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.path.replace(/^\\\\\?\\/, "")}</small>
                    </span>
                  </button>
                  <span className="recent-actions">
                    <button
                      title={ui.openInTerminal}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(async () => {
                          await api.openInTerminal(item.path);
                        });
                      }}
                    >
                      ⌨
                    </button>
                    <button
                      title={ui.openInExplorer}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(async () => {
                          await api.openDirectory(item.path);
                        });
                      }}
                    >
                      📂
                    </button>
                    <button
                      title={ui.copyPath}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigator.clipboard
                          .writeText(
                            item.path.replace(/^\\\\\?\\/, ""),
                          )
                          .then(() => setNotice(ui.pathCopied));
                      }}
                    >
                      📋
                    </button>
                    <button
                      className="recent-remove-btn"
                      title={ui.removeRecent}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(async () => {
                          const result = await api.removeRecent(item.path);
                          setRecent(result.recent);
                        });
                      }}
                    >
                      ✕
                    </button>
                  </span>
                  <button
                    className="recent-open-btn"
                    disabled={busy}
                    onClick={() => void openPath(item.path)}
                  >
                    →
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-recent">
                <span>▤</span>
                {ui.noRecent}
              </div>
            )}
          </section>
          <p className="roadmap-note">{ui.noGeneration}</p>
        </main>
      ) : (
        <>
          <div className="project-toolbar">
            <div className="project-location" title={project.root}>
              ▱ {project.root.replace(/^\\\\\?\\/, "")}
            </div>
            <button disabled={busy} onClick={() => void refresh()}>
              {ui.refresh}
            </button>
            <button disabled={busy} onClick={configureGeneration}>
              {ui.generation.apiSettings}
            </button>
          </div>
          {conflict && (
            <div className="banner conflict" role="alert">
              <span>{ui.conflict}</span>
              <button disabled={busy} onClick={() => void reload()}>
                {ui.reload}
              </button>
            </div>
          )}
          <main className="workspace storyboard-workspace">
            <aside className="sidebar">
              <div className="sidebar-heading">
                {ui.docs}
                <span>{documents.length}</span>
              </div>
              <nav className="document-list">
                {documents.map((doc) => (
                  <button
                    key={doc.path}
                    title={doc.path}
                    disabled={busy}
                    className={doc.path === path ? "selected" : ""}
                    onClick={() => void selectDocument(doc.path)}
                  >
                    <span>▤</span>
                    {doc.name}
                  </button>
                ))}
                {!documents.length && (
                  <p className="muted empty-nav">{ui.noDocs}</p>
                )}
              </nav>
              <div className="sidebar-heading shot-heading">
                {ui.shots}
                <span>{board.cards.length}</span>
              </div>
              <nav className="shot-list">
                {board.cards.map((shot) => (
                  <button
                    key={`${shot.id}-${shot.offset}`}
                    className={
                      board.cards[activeShot]?.offset === shot.offset
                        ? "selected"
                        : ""
                    }
                    onClick={() => jump(shot.offset)}
                  >
                    <code>{shot.id}</code>
                    <span>{shot.title}</span>
                  </button>
                ))}
                {!board.cards.length && (
                  <p className="muted empty-nav">{ui.noShots}</p>
                )}
              </nav>
              <div className="sidebar-footer">{ui.outlineNote}</div>
            </aside>
            <section className="editor-panel">
              <div className="panel-heading">
                <div>
                  <strong>{path.split("/").at(-1) || ui.raw}</strong>
                  <small>
                    {mode === "source"
                      ? ui.raw
                      : board.cards.length
                        ? ui.board.count(board.cards.length)
                        : ui.board.read}
                  </small>
                </div>
                <div className="mode-switch" aria-label={ui.board.mode}>
                  <button
                    aria-pressed={mode === "board"}
                    onClick={() => {
                      const offset = editor.current?.selectionStart ?? 0;
                      const index = board.cards.reduce(
                        (last, card, i) => (card.offset <= offset ? i : last),
                        -1,
                      );
                      if (mode === "source" && index >= 0) setActiveShot(index);
                      pendingJump.current = offset;
                      setMode("board");
                    }}
                  >
                    {ui.board.mode}
                  </button>
                  <button
                    aria-pressed={mode === "source"}
                    onClick={() =>
                      showSource(board.cards[activeShot]?.offset ?? 0)
                    }
                  >
                    {ui.raw}
                  </button>
                </div>
                <div className="save-actions">
                  <span className={`save-status ${dirty ? "dirty" : ""}`}>
                    {snapshot?.readonly
                      ? ui.readonly
                      : dirty
                        ? ui.unsaved
                        : ui.saved}
                  </span>
                  <button
                    className="primary-button"
                    disabled={busy || !dirty || snapshot?.readonly}
                    onClick={() => void save()}
                  >
                    {busy ? ui.busy : ui.save}
                  </button>
                </div>
              </div>
              {snapshot && mode === "source" ? (
                <textarea
                  ref={editor}
                  className="markdown-editor"
                  aria-label={ui.editorLabel}
                  spellCheck={false}
                  wrap="off"
                  value={text}
                  disabled={busy}
                  onChange={(event) => setText(event.target.value)}
                />
              ) : snapshot ? (
                <Storyboard
                  key={path}
                  board={board}
                  project={project}
                  document={path}
                  refreshKey={refreshKey}
                  busy={busy}
                  apply={apply}
                  source={showSource}
                  active={activeShot}
                  select={setActiveShot}
                  generationConfigured={generationSettings.profiles.some(
                    (profile) =>
                      profile.id === generationSettings.activeProfileId &&
                      profile.hasAuthorization,
                  )}
                  configureGeneration={configureGeneration}
                  useVideo={useGeneratedVideo}
                  showSourceActions={!isOverviewDocument(path)}
                />
              ) : (
                <div className="empty-editor">
                  ▤<p>{ui.empty}</p>
                </div>
              )}
              <div className="editor-footer">
                <span>{ui.statusHint}</span>
                <span>
                  {text.length.toLocaleString()} 字符 · {board.cards.length} 镜
                </span>
              </div>
            </section>
          </main>
        </>
      )}
      {(modal || candidates) && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <h2 id="modal-title">
              {candidates
                ? ui.selectProject
                : modal === "open"
                  ? ui.open
                  : modal === "project"
                    ? ui.newTitle
                    : modal === "libraries"
                      ? ui.librarySetup
                      : ui.generation.apiSettings}
            </h2>
            {candidates ? (
              <>
                <div className="candidate-list">
                  {candidates.list.map((item) => (
                    <button
                      disabled={busy}
                      key={item.path}
                      onClick={() => void openPath(item.path, false)}
                    >
                      ▤ {item.name} <span>→</span>
                    </button>
                  ))}
                </div>
                <button
                  disabled={busy}
                  onClick={() => void openPath(candidates.root, false)}
                >
                  {ui.openThis}
                </button>
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitModal();
                }}
              >
                {modal === "project" && (
                  <label>
                    {ui.name}
                    <input
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={ui.name}
                      required
                      disabled={busy}
                    />
                  </label>
                )}
                {modal === "api" ? (
                  <>
                    <label>
                      {ui.generation.activeProfile}
                      <select
                        value={apiDraft.activeProfileId}
                        disabled={busy}
                        onChange={(event) =>
                          setApiDraft((draft) => ({
                            ...draft,
                            activeProfileId: event.target.value,
                          }))
                        }
                      >
                        {apiDraft.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" disabled={busy} onClick={addApi}>
                      {ui.generation.addProfile}
                    </button>
                    <label>
                      {ui.generation.profileName}
                      <input
                        value={activeApi?.name ?? ""}
                        required
                        disabled={busy}
                        onChange={(event) =>
                          updateApi({ name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      {ui.generation.baseUrl}
                      <input
                        autoFocus
                        value={activeApi?.baseUrl ?? ""}
                        onChange={(event) =>
                          updateApi({ baseUrl: event.target.value })
                        }
                        placeholder="https://api.example.com"
                        required
                        disabled={busy}
                      />
                    </label>
                    <label>
                      {ui.generation.authorization}
                      <span className="secret-input">
                        <input
                          type={showApiToken ? "text" : "password"}
                          value={
                            apiAuthorizations[apiDraft.activeProfileId] ?? ""
                          }
                          onChange={(event) =>
                            setApiAuthorizations((values) => ({
                              ...values,
                              [apiDraft.activeProfileId]: event.target.value,
                            }))
                          }
                          placeholder={
                            activeApi?.hasAuthorization
                              ? ui.generation.savedAuthorization
                              : ui.generation.authorizationPlaceholder
                          }
                          autoComplete="new-password"
                          disabled={busy}
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setShowApiToken((visible) => !visible)}
                        >
                          {showApiToken
                            ? ui.generation.hideToken
                            : ui.generation.showToken}
                        </button>
                      </span>
                      {activeApi?.hasAuthorization && (
                        <small className="credential-status">
                          {ui.generation.tokenSaved}
                        </small>
                      )}
                      <small>{ui.generation.authorizationHint}</small>
                    </label>
                  </>
                ) : modal === "project" ||
                  modal === "open" ||
                  modal === "libraries" ? (
                  <>
                    {modal !== "libraries" && (
                      <>
                        <label>
                          {modal === "open" ? ui.directoryPath : ui.parent}
                          <div className="directory-input">
                            <input
                              value={parent}
                              onChange={(event) =>
                                setParent(event.target.value)
                              }
                              disabled={busy}
                              required
                              placeholder={ui.choose}
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const chosen = await chooseDirectory();
                                  if (chosen) setParent(chosen);
                                })
                              }
                            >
                              {ui.choose}
                            </button>
                          </div>
                        </label>
                        <p className="muted">
                          {modal === "open" ? ui.pathHint : ui.createFolder}
                        </p>
                      </>
                    )}
                    {modal !== "open" && (
                      <>
                        {modal === "libraries" && (
                          <p className="muted">{ui.librarySetupExisting}</p>
                        )}
                        <label>
                          {ui.characterDirectory}
                          <div className="directory-input">
                            <input
                              value={characterDirectory}
                              onChange={(event) =>
                                setCharacterDirectory(event.target.value)
                              }
                              disabled={busy}
                              placeholder={ui.choose}
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const chosen = await chooseDirectory();
                                  if (chosen) setCharacterDirectory(chosen);
                                })
                              }
                            >
                              {ui.choose}
                            </button>
                          </div>
                          <small>{ui.characterHint}</small>
                        </label>
                        <label>
                          {ui.voiceDirectory}
                          <div className="directory-input">
                            <input
                              value={voiceDirectory}
                              onChange={(event) =>
                                setVoiceDirectory(event.target.value)
                              }
                              disabled={busy}
                              required
                              placeholder={ui.choose}
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const chosen = await chooseDirectory();
                                  if (chosen) setVoiceDirectory(chosen);
                                })
                              }
                            >
                              {ui.choose}
                            </button>
                            <button
                              type="button"
                              disabled={busy || !voiceDirectory.trim()}
                              onClick={() =>
                                void run(async () => {
                                  await api.openDirectory(
                                    voiceDirectory.trim(),
                                  );
                                })
                              }
                            >
                              {ui.openDirectory}
                            </button>
                          </div>
                          <small>{ui.voiceHint}</small>
                        </label>
                        <p className="muted">{ui.libraryImportHint}</p>
                      </>
                    )}
                  </>
                ) : null}
                <div className="modal-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setModal(null);
                      setPendingProject("");
                    }}
                  >
                    {ui.cancel}
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      busy ||
                      (modal === "project" && !name.trim()) ||
                      (modal === "api" &&
                        apiDraft.profiles.some(
                          (profile) =>
                            !profile.baseUrl.trim() || !profile.name.trim(),
                        )) ||
                      ((modal === "project" || modal === "open") &&
                        !parent.trim()) ||
                      ((modal === "project" || modal === "libraries") &&
                        !voiceDirectory.trim())
                    }
                  >
                    {busy ? ui.busy : ui.confirm}
                  </button>
                </div>
              </form>
            )}
            {candidates && (
              <div className="modal-actions">
                <button disabled={busy} onClick={() => setCandidates(null)}>
                  {ui.cancel}
                </button>
              </div>
            )}
            {error && (
              <p className="warning-text" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
      {unsavedDialog}
    </div>
  );
}
