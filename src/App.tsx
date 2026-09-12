import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, chooseDirectory, desktop, errorMessage } from "./api";
import { analyzeMarkdown, documentTemplate, sortDocuments } from "./markdown";
import { ui } from "./i18n";
import Preview, { Asset } from "./Preview";
import { useUnsavedChanges } from "./useUnsavedChanges";
import type {
  Candidate,
  DocumentEntry,
  Project,
  Recent,
  Snapshot,
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
  const [previewVisible, setPreviewVisible] = useState(true);
  const [previewTab, setPreviewTab] = useState<"document" | "assets">(
    "document",
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [modal, setModal] = useState<
    "project" | "open" | "document" | "saveAs" | null
  >(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [template, setTemplate] = useState("episode");
  const [candidates, setCandidates] = useState<{
    root: string;
    list: Candidate[];
  } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = snapshot !== null && text !== snapshot.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const analysis = useMemo(() => analyzeMarkdown(text), [text]);
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
    setPreviewVisible(prefs.previewVisible ?? true);
  }, []);
  useEffect(() => {
    if (desktop) void loadPreferences().catch((e) => setError(errorMessage(e)));
  }, [loadPreferences]);
  const replaceDocument = (nextPath: string, next: Snapshot) => {
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
      await installProject(await api.open(selected));
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
  const showNewDocument = (saveAs = false) => {
    setName(
      saveAs
        ? path.replace(/\.md$/i, " 副本.md")
        : `${String(documents.filter((d) => /^\d+/.test(d.name)).length + 1).padStart(2, "0")} 新的一集.md`,
    );
    setTemplate("episode");
    setModal(saveAs ? "saveAs" : "document");
  };
  const submitModal = () =>
    run(async () => {
      if (modal === "open") {
        if (!parent.trim()) return;
        const list = await api.inspect(parent.trim());
        if (list.length) {
          setModal(null);
          setCandidates({ root: parent.trim(), list });
          return;
        }
        await installProject(await api.open(parent.trim()));
      } else if (modal === "project") {
        if (!parent || !name.trim()) return;
        await installProject(await api.create(parent, name.trim()));
      } else if (project) {
        if (modal !== "saveAs" && dirty && !(await discardChanges())) return;
        const filename = /\.md$/i.test(name.trim())
          ? name.trim()
          : `${name.trim()}.md`;
        const next = await api.newDoc(
          project.handle,
          filename,
          modal === "saveAs" ? text : documentTemplate(template, filename),
        );
        replaceDocument(filename, next);
        await scan(project);
        setModal(null);
        setNotice(ui.saved);
      }
    });
  const jump = (offset: number) => {
    const area = editor.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(offset, offset);
    const lines = text.slice(0, offset).split("\n").length;
    area.scrollTop = Math.max(0, (lines - 3) * 24);
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
        <span className="local-badge">
          <i />
          {ui.local}
        </span>
        <span className="version">{ui.p0}</span>
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
                setName("");
                setParent("");
                setModal("project");
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
                <button
                  className="recent-project"
                  key={item.path}
                  disabled={busy}
                  onClick={() => void openPath(item.path)}
                >
                  <span className="project-icon">▤</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.path.replace(/^\\\\\?\\/, "")}</small>
                  </span>
                  <span className="recent-arrow">→</span>
                </button>
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
            <button disabled={busy} onClick={() => showNewDocument()}>
              ＋ {ui.newDocument}
            </button>
            <button disabled={busy} onClick={() => void refresh()}>
              {ui.refresh}
            </button>
            <button
              onClick={() => {
                const value = !previewVisible;
                setPreviewVisible(value);
                void api
                  .setPreview(value)
                  .catch((e) => setError(errorMessage(e)));
              }}
              aria-pressed={previewVisible}
            >
              {ui.togglePreview}
            </button>
          </div>
          {conflict && (
            <div className="banner conflict" role="alert">
              <span>{ui.conflict}</span>
              <button disabled={busy} onClick={() => showNewDocument(true)}>
                {ui.saveAs}
              </button>
              <button disabled={busy} onClick={() => void reload()}>
                {ui.reload}
              </button>
            </div>
          )}
          <main
            className={`workspace ${previewVisible ? "" : "without-preview"}`}
          >
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
                <span>{analysis.shots.length}</span>
              </div>
              <nav className="shot-list">
                {analysis.shots.map((shot) => (
                  <button
                    key={`${shot.id}-${shot.offset}`}
                    onClick={() => jump(shot.offset)}
                  >
                    <code>{shot.id}</code>
                    <span>{shot.title}</span>
                  </button>
                ))}
                {!analysis.shots.length && (
                  <p className="muted empty-nav">{ui.noShots}</p>
                )}
              </nav>
              <div className="sidebar-footer">{ui.outlineNote}</div>
            </aside>
            <section className="editor-panel">
              <div className="panel-heading">
                <div>
                  <strong>{path.split("/").at(-1) || ui.raw}</strong>
                  <small>{ui.raw}</small>
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
                    disabled={busy || !snapshot}
                    onClick={() => showNewDocument(true)}
                  >
                    {ui.saveAs}
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy || !dirty || snapshot?.readonly}
                    onClick={() => void save()}
                  >
                    {busy ? ui.busy : ui.save}
                  </button>
                </div>
              </div>
              {snapshot ? (
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
              ) : (
                <div className="empty-editor">
                  ▤<p>{ui.empty}</p>
                </div>
              )}
              <div className="editor-footer">
                <span>{ui.statusHint}</span>
                <span>
                  {text.length.toLocaleString()} 字符 · {analysis.shots.length}{" "}
                  镜
                </span>
              </div>
            </section>
            {previewVisible && (
              <section className="preview-panel">
                <div className="preview-tabs">
                  <button
                    className={previewTab === "document" ? "active" : ""}
                    onClick={() => setPreviewTab("document")}
                  >
                    {ui.preview}
                  </button>
                  <button
                    className={previewTab === "assets" ? "active" : ""}
                    onClick={() => setPreviewTab("assets")}
                  >
                    {ui.assets}
                    <span>{analysis.references.length}</span>
                  </button>
                </div>
                <div className="preview-content">
                  {analysis.diagnostics.map((message) => (
                    <p className="diagnostic" key={message}>
                      {message}
                    </p>
                  ))}
                  {previewTab === "document" ? (
                    <Preview text={text} />
                  ) : (
                    <div className="asset-list">
                      {analysis.references.length ? (
                        analysis.references.map((reference) => (
                          <Asset
                            key={`${path}-${reference}`}
                            project={project}
                            document={path}
                            reference={reference}
                            refreshKey={refreshKey}
                          />
                        ))
                      ) : (
                        <p className="muted">{ui.noAssets}</p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}
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
                    : modal === "saveAs"
                      ? ui.saveAs
                      : ui.newDocument}
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
                {modal !== "open" && (
                  <label>
                    {modal === "project" ? ui.name : ui.filename}
                    <input
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={
                        modal === "project" ? ui.name : ui.filenameExample
                      }
                      required
                      disabled={busy}
                    />
                  </label>
                )}
                {modal === "project" || modal === "open" ? (
                  <>
                    <label>
                      {modal === "open" ? ui.directoryPath : ui.parent}
                      <div className="directory-input">
                        <input
                          value={parent}
                          onChange={(event) => setParent(event.target.value)}
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
                ) : (
                  modal !== "saveAs" && (
                    <label>
                      {ui.template}
                      <select
                        value={template}
                        onChange={(event) => {
                          const kind = event.target.value;
                          setTemplate(kind);
                          if (kind === "outline") setName("剧本大纲.md");
                          if (kind === "table") setName("分镜总表.md");
                        }}
                      >
                        <option value="episode">{ui.episode}</option>
                        <option value="outline">{ui.outline}</option>
                        <option value="table">{ui.table}</option>
                        <option value="blank">{ui.blank}</option>
                      </select>
                    </label>
                  )
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setModal(null)}
                  >
                    {ui.cancel}
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      busy ||
                      (modal !== "open" && !name.trim()) ||
                      ((modal === "project" || modal === "open") &&
                        !parent.trim())
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
