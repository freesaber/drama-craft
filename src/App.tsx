import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, chooseDirectory, desktop, errorMessage } from "./api";
import BatchGenerateDialog from "./BatchGenerateDialog";
import BatchAudioDialog from "./BatchAudioDialog";
import AudioApiDialog from "./AudioApiDialog";
import MergeDialog from "./MergeDialog";
import { isOverviewDocument, sortDocuments } from "./markdown";
import {
  filterAndSortProjects,
  projectPage,
  projectPageCount,
} from "./projectList";
import { ui } from "./i18n";
import Storyboard from "./BoardView";
import TaskListView from "./TaskListView";
import { retryGenerationDownload } from "./generationRetry";
import { applySourcePatch, fieldPatch, parseStoryboard } from "./storyboard";
import { applyBatchVideoDocument } from "./batchVideo";
import { useUnsavedChanges } from "./useUnsavedChanges";
import type {
  ApiProfile,
  BatchJob,
  BatchJobItem,
  Candidate,
  DocumentEntry,
  GenerationSettings,
  Project,
  Recent,
  Snapshot,
  SourcePatch,
} from "./types";
import {
  API_PLATFORM_TYPES,
  AUTODL_RESOLUTION_PRESETS,
  autodlApiProfile,
  type AutodlPreset,
  compactResolutionsJson,
  emptyApiProfile,
  fillEmptyAutodlPreset,
  migrateGenerationSettings,
  optionsFromProfile,
} from "./videoWorkflows";

const projectListIcons = {
  search: "M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  folder:
    "M3 7V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  plus: "M12 5v14M5 12h14",
  project:
    "M5 5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5Zm9-2v5h5M9 12h6m-6 4h6",
  terminal:
    "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm4 3 3 3-3 3m6 0h4",
  copy: "M8 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3M8 10a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9Z",
  rename: "m14 6 4 4M4 20l1-5L16 4a2.8 2.8 0 0 1 4 4L9 19l-5 1Z",
  remove: "M6 6l12 12M18 6 6 18",
};

function ProjectListIcon({ name }: { name: keyof typeof projectListIcons }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={projectListIcons[name]} />
    </svg>
  );
}

export default function App() {
  const { ask: discardChanges, dialog: unsavedDialog } = useUnsavedChanges();
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [path, setPath] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [currentProjectPage, setCurrentProjectPage] = useState(1);
  const [pendingRecentRemoval, setPendingRecentRemoval] =
    useState<Recent | null>(null);
  const [pendingRecentRename, setPendingRecentRename] = useState<Recent | null>(
    null,
  );
  const [renameName, setRenameName] = useState("");
  const [renameFolder, setRenameFolder] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [mode, setMode] = useState<"board" | "source">("board");
  const [workspaceView, setWorkspaceView] = useState<
    "storyboard" | "tasks"
  >("storyboard");
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [showAudioBatchDialog, setShowAudioBatchDialog] = useState(false);
  const [showAudioApiDialog, setShowAudioApiDialog] = useState(false);
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [discardedShots, setDiscardedShots] = useState<string[]>([]);
  const appliedBatchItems = useRef(new Set<string>());
  const [activeShot, setActiveShot] = useState(0);
  const pendingJump = useRef<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generationSettings, setGenerationSettings] =
    useState<GenerationSettings>({
      profiles: [],
      activeProfileId: "",
      defaultResolution: "480p横(864*480)",
    });
  const [apiDraft, setApiDraft] = useState<GenerationSettings>({
    profiles: [],
    activeProfileId: "",
    defaultResolution: "480p横(864*480)",
  });
  const [apiAuthorizations, setApiAuthorizations] = useState<
    Record<string, string>
  >({});
  const [showApiToken, setShowApiToken] = useState(false);
  const activeApi = apiDraft.profiles.find(
    (profile) => profile.id === apiDraft.activeProfileId,
  );
  const activeApiTokenDraft = activeApi
    ? apiAuthorizations[activeApi.id]
    : undefined;
  const activeApiTokenInDraft = activeApiTokenDraft !== undefined;
  const activeApiHasToken = activeApiTokenInDraft
    ? Boolean(activeApiTokenDraft.trim())
    : Boolean(activeApi?.hasAuthorization);
  const activeApiTokenDisplay = showApiToken
    ? (activeApiTokenDraft ?? "")
    : activeApiHasToken
      ? activeApiTokenInDraft
        ? activeApiTokenDraft
        : "••••••••••••••••••••••••••••••••"
      : (activeApiTokenDraft ?? "");
  const activeApiTokenReadOnly =
    !showApiToken && activeApiHasToken && !activeApiTokenInDraft;
  const updateApi = (values: Partial<ApiProfile>) =>
    setApiDraft((draft) => ({
      ...draft,
      profiles: draft.profiles.map((profile) =>
        profile.id === draft.activeProfileId
          ? { ...profile, ...values }
          : profile,
      ),
    }));
  const addApi = (preset?: AutodlPreset) => {
    const reuseEmpty =
      preset &&
      activeApi &&
      !activeApi.submitUrl.trim() &&
      !activeApi.queryUrl.trim() &&
      !activeApi.resolutions.trim() &&
      !activeApi.defaultSeed.trim() &&
      !activeApi.hasAuthorization &&
      !activeApiTokenDraft;
    const id = reuseEmpty ? activeApi.id : crypto.randomUUID();
    setShowApiToken(false);
    setApiDraft((draft) => ({
      ...draft,
      activeProfileId: id,
      profiles: [
        ...draft.profiles.filter((profile) => profile.id !== id),
        preset
          ? autodlApiProfile(id, preset)
          : emptyApiProfile(
              id,
              `${ui.generation.profileName} ${draft.profiles.length + 1}`,
            ),
      ],
    }));
  };
  const deleteApi = () => {
    if (!activeApi) return;
    const deletedId = activeApi.id;
    setApiDraft((draft) => {
      const deletedIndex = draft.profiles.findIndex(
        (profile) => profile.id === deletedId,
      );
      const profiles = draft.profiles.filter(
        (profile) => profile.id !== deletedId,
      );
      const nextProfile = profiles[Math.min(deletedIndex, profiles.length - 1)];
      return {
        ...draft,
        profiles,
        activeProfileId: nextProfile?.id ?? "",
      };
    });
    setApiAuthorizations((values) => {
      const next = { ...values };
      delete next[deletedId];
      return next;
    });
    setShowApiToken(false);
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
  const episodeMergeRunning = useMemo(
    () =>
      batchJobs.some(
        (job) =>
          job.jobType === "merge" &&
          ["scheduled", "running"].includes(job.status) &&
          job.document.replace(/\\/g, "/") === path.replace(/\\/g, "/"),
      ),
    [batchJobs, path],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const activeVideoOptions = useMemo(() => {
    const profile = generationSettings.profiles.find(
      (item) => item.id === generationSettings.activeProfileId,
    );
    return optionsFromProfile(profile);
  }, [generationSettings]);
  const filteredProjects = useMemo(
    () => filterAndSortProjects(recent, projectSearch),
    [recent, projectSearch],
  );
  const totalProjectPages = projectPageCount(filteredProjects.length);
  const visibleProjects = useMemo(
    () => projectPage(filteredProjects, currentProjectPage),
    [filteredProjects, currentProjectPage],
  );
  useEffect(() => {
    setCurrentProjectPage((page) => Math.min(page, totalProjectPages));
  }, [totalProjectPages]);
  const textRef = useRef(text);
  textRef.current = text;
  const pathRef = useRef(path);
  pathRef.current = path;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
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
        .then((settings) =>
          setGenerationSettings(migrateGenerationSettings(settings)),
        )
        .catch((e) => setError(errorMessage(e)));
    }
  }, [loadPreferences]);
  useEffect(() => {
    if (!project || !path) {
      setDiscardedShots([]);
      return;
    }
    let cancelled = false;
    void api
      .listDiscardedShots(project.handle, path)
      .then((ids) => {
        if (!cancelled) setDiscardedShots(ids);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project, path]);
  const toggleDiscardedShot = async (shotId: string, discarded: boolean) => {
    if (!project) return;
    try {
      setDiscardedShots(
        await api.setShotDiscarded(project.handle, path, shotId, discarded),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };
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
    setWorkspaceView("storyboard");
    setBatchJobs([]);
    appliedBatchItems.current.clear();
    setDiscardedShots([]);
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
  const revert = () =>
    run(async () => {
      if (!snapshot || !dirty) return;
      if (!(await discardChanges())) return;
      textRef.current = snapshot.text;
      setText(snapshot.text);
      setConflict(false);
      setNotice(ui.reverted);
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
        }
      } catch (e) {
        if (dirty) setConflict(true);
        throw e;
      }
    });
  const refreshIfChanged = async () => {
    if (!project || !path || !snapshot || busyRef.current) return;
    try {
      const disk = await api.read(project.handle, path);
      if (disk.hash !== snapshot.hash) await refresh(true);
    } catch (e) {
      if (dirtyRef.current) setConflict(true);
      else setError(errorMessage(e));
    }
  };
  const callbacks = useRef({ save, refreshIfChanged });
  callbacks.current = { save, refreshIfChanged };
  useEffect(() => {
    const focus = () => {
      void callbacks.current.refreshIfChanged();
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
      setWorkspaceView("storyboard");
      setBatchJobs([]);
      appliedBatchItems.current.clear();
      setShowBatchDialog(false);
      setShowAudioBatchDialog(false);
      setShowAudioApiDialog(false);
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
          parent.trim(),
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
    setApiAuthorizations({});
    setShowApiToken(false);
    if (!generationSettings.profiles.length) {
      const id = crypto.randomUUID();
      setApiDraft({
        activeProfileId: id,
        defaultResolution: generationSettings.defaultResolution,
        profiles: [emptyApiProfile(id, ui.generation.defaultProfile)],
      });
    } else {
      const migrated = migrateGenerationSettings(generationSettings);
      setApiDraft({
        ...migrated,
        profiles: migrated.profiles.map((profile) => ({
          ...profile,
          resolutions: compactResolutionsJson(profile.resolutions),
        })),
      });
    }
    setModal("api");
  };
  const toggleApiToken = () => {
    if (showApiToken) {
      setShowApiToken(false);
      return;
    }
    if (!activeApi) return;
    if (activeApiTokenDraft !== undefined) {
      setShowApiToken(true);
      return;
    }
    void run(async () => {
      const authorization = await api.generationAuthorization(activeApi.id);
      setApiAuthorizations((values) => ({
        ...values,
        [activeApi.id]: authorization,
      }));
      setShowApiToken(true);
    });
  };
  const savePromptPatch = async (patch: SourcePatch) => {
    if (!project || !snapshot) throw new Error(ui.generation.noDocument);
    if (snapshot.readonly) throw new Error(ui.readonly);
    if (busyRef.current) throw new Error(ui.busy);
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const nextText = applySourcePatch(textRef.current, patch);
      const saved = await api.save(
        project.handle,
        path,
        nextText,
        snapshot.hash,
      );
      replaceDocument(path, saved);
      setNotice(ui.saved);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "conflict")
        setConflict(true);
      throw e;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
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
  const applyBatchVideo = useCallback(
    async (
      documentPath: string,
      shotId: string,
      reference: string,
      replaceExisting: boolean,
    ) => {
      if (!project) return false;
      const currentSnapshot = snapshotRef.current;
      const currentPath = pathRef.current;
      const isCurrent = documentPath === currentPath;
      if (
        isCurrent &&
        (!currentSnapshot ||
          currentSnapshot.readonly ||
          dirtyRef.current ||
          busyRef.current)
      )
        return false;
      if (isCurrent) {
        busyRef.current = true;
        setBusy(true);
      }
      try {
        const result = await applyBatchVideoDocument(
          {
            read: api.read,
            save: api.save,
            exists: async (handle, document, current) =>
              (await api.media(handle, document, current)).exists,
          },
          project.handle,
          documentPath,
          shotId,
          reference,
          isCurrent && currentSnapshot
            ? { ...currentSnapshot, text: textRef.current }
            : undefined,
          replaceExisting,
        );
        if (isCurrent && result.changed) {
          replaceDocument(currentPath, result.snapshot);
          setRefreshKey((key) => key + 1);
          setNotice(ui.batch.applyVideo);
        }
        return true;
      } catch (e) {
        if (
          isCurrent &&
          e &&
          typeof e === "object" &&
          "code" in e &&
          e.code === "conflict"
        )
          setConflict(true);
        setError(errorMessage(e));
        return false;
      } finally {
        if (isCurrent) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [project],
  );
  const refreshBatchJobs = useCallback(async () => {
    if (!project) return;
    const jobs = await api.syncBatchJobs(project.handle);
    setBatchJobs(jobs);
  }, [project]);
  const retryBatchGenerationDownload = useCallback(
    async (job: BatchJob, item: BatchJobItem) => {
      if (!project || !item.generationTaskId) return;
      const record = await retryGenerationDownload(
        item.generationTaskId,
        (taskId) => api.pollGeneration(project.handle, taskId),
      );
      const applied = await applyBatchVideo(
        job.document,
        item.shotId,
        record.localFile,
        true,
      );
      if (applied) {
        await api.markBatchVideoApplied(
          project.handle,
          item.itemId,
          record.localFile,
        );
        appliedBatchItems.current.add(item.itemId);
      }
      setBatchJobs(await api.syncBatchJobs(project.handle));
    },
    [project, applyBatchVideo],
  );
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    let running = false;
    const sameJobs = (left: BatchJob[], right: BatchJob[]) =>
      left.length === right.length &&
      left.every(
        (job, index) =>
          job.jobId === right[index]?.jobId &&
          job.status === right[index]?.status &&
          job.updatedAt === right[index]?.updatedAt &&
          job.itemCompleted === right[index]?.itemCompleted &&
          job.itemCancelled === right[index]?.itemCancelled &&
          job.itemFailed === right[index]?.itemFailed,
      );
    const applyCompletedVideos = async (
      jobs: BatchJob[],
      completedBeforePoll: Set<string>,
    ) => {
      const handledShots = new Set<string>();
      for (const job of jobs) {
        if (job.jobType !== "generation") continue;
        for (const item of job.items) {
          const shotKey = `${job.document}\u0000${item.shotId}`;
          if (
            item.status !== "completed" ||
            !item.localFile ||
            item.appliedAt ||
            handledShots.has(shotKey) ||
            appliedBatchItems.current.has(item.itemId)
          )
            continue;
          handledShots.add(shotKey);
          if (
            await applyBatchVideo(
              job.document,
              item.shotId,
              item.localFile,
              !completedBeforePoll.has(item.itemId),
            )
          ) {
            await api.markBatchVideoApplied(
              project.handle,
              item.itemId,
              item.localFile,
            );
            appliedBatchItems.current.add(item.itemId);
          }
        }
      }
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const synced = await api.syncBatchJobs(project.handle);
        const completedBeforePoll = new Set(
          synced.flatMap((job) =>
            job.items
              .filter((item) => item.status === "completed")
              .map((item) => item.itemId),
          ),
        );
        const active = synced.some((job) =>
          ["scheduled", "running"].includes(job.status),
        );
        if (!active && synced.length === 0) {
          if (!cancelled) {
            setBatchJobs((current) => (current.length ? [] : current));
          }
          return;
        }
        for (const job of synced) {
          for (const item of job.items) {
            if (
              !item.generationTaskId ||
              !["submitted", "running"].includes(item.status)
            )
              continue;
            try {
              if (job.jobType === "audio")
                await api.pollAudio(project.handle, item.generationTaskId);
              else if (job.jobType === "generation")
                await api.pollGeneration(project.handle, item.generationTaskId);
            } catch {
              /* keep polling later */
            }
          }
        }
        const afterPoll = await api.syncBatchJobs(project.handle);
        if (cancelled) return;
        await applyCompletedVideos(afterPoll, completedBeforePoll);
        if (cancelled) return;
        await api.advanceBatchJobs(project.handle).catch(() => null);
        if (cancelled) return;
        const audioAdvanced = await api
          .advanceAudioJobs(project.handle)
          .catch(() => null);
        if (cancelled) return;
        const latestJobs =
          audioAdvanced?.jobs ?? (await api.syncBatchJobs(project.handle));
        setBatchJobs((current) =>
          sameJobs(current, latestJobs) ? current : latestJobs,
        );
      } catch {
        /* batch runner is best-effort while the project stays open */
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [project, applyBatchVideo]);
  return (
    <div className="app-shell">
      <header className={project ? "topbar" : "topbar home-topbar"}>
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
        <div className="toast-host" aria-live="polite">
          <div role="status" className="toast toast-success">
            {notice}
          </div>
        </div>
      )}
      {!project ? (
        <main className="home-page">
          <div className="project-list-toolbar">
            <div className="project-list-heading">
              <h1 id="project-list-title">{ui.recent}</h1>
              <span aria-live="polite">
                {ui.projectListResult(filteredProjects.length)}
              </span>
            </div>
            <div className="project-list-search">
              <ProjectListIcon name="search" />
              <input
                type="search"
                value={projectSearch}
                onChange={(event) => {
                  setProjectSearch(event.target.value);
                  setCurrentProjectPage(1);
                }}
                placeholder={ui.searchProjects}
                aria-label={ui.searchProjects}
              />
            </div>
            <div className="project-list-actions">
              <button
                disabled={!desktop || busy}
                onClick={() => void openDirectory()}
              >
                <ProjectListIcon name="folder" />
                {ui.open}
              </button>
              <button
                className="primary-button"
                disabled={!desktop || busy}
                onClick={() => {
                  void run(async () => {
                    const { newProjectDirectories: directories } =
                      await api.preferences();
                    const voices =
                      directories?.voiceDirectory ||
                      defaultVoiceDirectory ||
                      (await api.defaultVoiceDirectory());
                    setName("");
                    setParent(directories?.parent ?? "");
                    setCharacterDirectory(
                      directories?.characterDirectory ?? "",
                    );
                    setVoiceDirectory(voices);
                    setModal("project");
                  });
                }}
              >
                <ProjectListIcon name="plus" />
                {ui.create}
              </button>
            </div>
          </div>
          <div className="project-list-panel">
            <div className="project-table-scroll">
              <table
                className="project-table"
                aria-labelledby="project-list-title"
              >
                <thead>
                  <tr>
                    <th scope="col">{ui.projectName}</th>
                    <th scope="col">{ui.directoryPath}</th>
                    <th scope="col">{ui.projectActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProjects.map((item) => {
                    const displayPath = item.path.replace(/^\\\\\?\\/, "");
                    return (
                      <tr key={item.path}>
                        <td>
                          <button
                            className="recent-project-main"
                            title={item.name}
                            disabled={busy}
                            onClick={() => void openPath(item.path)}
                          >
                            <span className="project-icon">
                              <ProjectListIcon name="project" />
                            </span>
                            <strong>{item.name}</strong>
                          </button>
                        </td>
                        <td className="project-directory" title={displayPath}>
                          {displayPath}
                        </td>
                        <td>
                          <div className="recent-actions">
                            <button
                              title={ui.openInTerminal}
                              aria-label={ui.openInTerminal}
                              disabled={busy}
                              onClick={() =>
                                void run(() => api.openInTerminal(item.path))
                              }
                            >
                              <ProjectListIcon name="terminal" />
                            </button>
                            <button
                              title={ui.openInExplorer}
                              aria-label={ui.openInExplorer}
                              disabled={busy}
                              onClick={() =>
                                void run(() => api.openDirectory(item.path))
                              }
                            >
                              <ProjectListIcon name="folder" />
                            </button>
                            <button
                              title={ui.copyPath}
                              aria-label={ui.copyPath}
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await navigator.clipboard.writeText(
                                    displayPath,
                                  );
                                  setNotice(ui.pathCopied);
                                })
                              }
                            >
                              <ProjectListIcon name="copy" />
                            </button>
                            <button
                              title={ui.renameProject}
                              aria-label={ui.renameProject}
                              disabled={busy}
                              onClick={() => {
                                setPendingRecentRename(item);
                                setRenameName(item.name);
                                setRenameFolder(true);
                              }}
                            >
                              <ProjectListIcon name="rename" />
                            </button>
                            <button
                              className="recent-remove-btn"
                              title={ui.removeRecent}
                              aria-label={ui.removeRecent}
                              disabled={busy}
                              onClick={() => setPendingRecentRemoval(item)}
                            >
                              <ProjectListIcon name="remove" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {visibleProjects.length === 0 && (
                    <tr>
                      <td colSpan={3}>
                        <div className="empty-recent">
                          <span className="project-icon">
                            <ProjectListIcon name="project" />
                          </span>
                          {recent.length ? ui.noProjectMatch : ui.noRecent}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {totalProjectPages > 1 && (
              <nav className="project-pagination" aria-label={ui.pagination}>
                <button
                  disabled={busy || currentProjectPage === 1}
                  onClick={() =>
                    setCurrentProjectPage((page) => Math.max(1, page - 1))
                  }
                >
                  {ui.previousPage}
                </button>
                <span>
                  {currentProjectPage} / {totalProjectPages}
                </span>
                <button
                  disabled={busy || currentProjectPage === totalProjectPages}
                  onClick={() =>
                    setCurrentProjectPage((page) =>
                      Math.min(totalProjectPages, page + 1),
                    )
                  }
                >
                  {ui.nextPage}
                </button>
              </nav>
            )}
          </div>
        </main>
      ) : (
        <>
          {workspaceView !== "tasks" && (
            <div className="project-toolbar">
              <div className="project-location" title={project.root}>
                ▱ {project.root.replace(/^\\\\\?\\/, "")}
              </div>
              <div className="project-location-actions">
                <button
                  title={ui.copyPath}
                  aria-label={ui.copyPath}
                  onClick={() => {
                    const documentPath = `${project.root.replace(/[\\/]+$/, "")}\\${path.replace(/^[/\\]+/, "").replaceAll("/", "\\")}`;
                    void navigator.clipboard
                      .writeText(documentPath.replace(/^\\\\\?\\/, ""))
                      .then(() => setNotice(ui.pathCopied))
                      .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  ⧉
                </button>
                <button
                  disabled={busy}
                  title={ui.openInTerminal}
                  aria-label={ui.openInTerminal}
                  onClick={() => {
                    void run(async () => {
                      await api.openInTerminal(project.root);
                    });
                  }}
                >
                  ⌨
                </button>
                <button
                  disabled={busy}
                  title={ui.openInExplorer}
                  aria-label={ui.openInExplorer}
                  onClick={() => {
                    void run(async () => {
                      await api.openDirectory(project.root);
                    });
                  }}
                >
                  📂
                </button>
              </div>
              <span className="project-toolbar-spacer" />
              <button disabled={busy} onClick={() => void refresh()}>
                {ui.refresh}
              </button>
              <button disabled={busy} onClick={configureGeneration}>
                {ui.generation.apiSettings}
              </button>
              <button
                disabled={busy}
                onClick={() => setShowAudioApiDialog(true)}
              >
                {ui.audio.apiSettings}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setWorkspaceView("tasks");
                  void refreshBatchJobs().catch((e) =>
                    setError(errorMessage(e)),
                  );
                }}
              >
                {ui.batch.tasks}
              </button>
            </div>
          )}
          {conflict && (
            <div className="banner conflict" role="alert">
              <span>{ui.conflict}</span>
              <button disabled={busy} onClick={() => void reload()}>
                {ui.reload}
              </button>
            </div>
          )}
          {workspaceView === "tasks" ? (
            <TaskListView
              project={project}
              jobs={batchJobs}
              busy={busy}
              onBack={() => setWorkspaceView("storyboard")}
              onRefresh={refreshBatchJobs}
              onJobsChange={setBatchJobs}
              onRetryGeneration={retryBatchGenerationDownload}
            />
          ) : (
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
                  <div
                    className="chapter-nav"
                    aria-label={ui.chapterNavigation}
                  >
                    <button
                      type="button"
                      disabled={
                        busy ||
                        documents.findIndex((doc) => doc.path === path) <= 0
                      }
                      onClick={() => {
                        const index = documents.findIndex(
                          (doc) => doc.path === path,
                        );
                        if (index > 0)
                          void selectDocument(documents[index - 1].path);
                      }}
                    >
                      {ui.previousChapter}
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        documents.findIndex((doc) => doc.path === path) < 0 ||
                        documents.findIndex((doc) => doc.path === path) >=
                          documents.length - 1
                      }
                      onClick={() => {
                        const index = documents.findIndex(
                          (doc) => doc.path === path,
                        );
                        if (index >= 0 && index < documents.length - 1)
                          void selectDocument(documents[index + 1].path);
                      }}
                    >
                      {ui.nextChapter}
                    </button>
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
                        if (mode === "source" && index >= 0)
                          setActiveShot(index);
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
                      type="button"
                      disabled={busy || !dirty || snapshot?.readonly}
                      onClick={() => void revert()}
                    >
                      {ui.revert}
                    </button>
                    <button
                      className="primary-button"
                      disabled={busy || !dirty || snapshot?.readonly}
                      onClick={() => void save()}
                    >
                      {busy ? ui.busy : ui.save}
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !board.cards.length ||
                        isOverviewDocument(path) ||
                        snapshot?.readonly
                      }
                      onClick={() => setShowBatchDialog(true)}
                    >
                      {ui.batch.generate}
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !board.episode.dialogues.length ||
                        isOverviewDocument(path)
                      }
                      onClick={() => setShowAudioBatchDialog(true)}
                    >
                      {ui.batch.audio}
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !board.cards.length ||
                        isOverviewDocument(path) ||
                        snapshot?.readonly
                      }
                      onClick={() => setShowMergeDialog(true)}
                    >
                      {ui.batch.merge}
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
                    documents={documents}
                    refreshKey={refreshKey}
                    busy={busy}
                    apply={apply}
                    savePatch={savePromptPatch}
                    readonly={Boolean(snapshot.readonly)}
                    source={showSource}
                    active={activeShot}
                    select={setActiveShot}
                    generationConfigured={generationSettings.profiles.some(
                      (profile) =>
                        profile.id === generationSettings.activeProfileId &&
                        profile.hasAuthorization &&
                        Boolean(profile.submitUrl?.trim()) &&
                        Boolean(profile.queryUrl?.trim()),
                    )}
                    videoApiProfiles={generationSettings.profiles}
                    videoWorkflow={activeVideoOptions}
                    configureGeneration={configureGeneration}
                    useVideo={useGeneratedVideo}
                    showSourceActions={!isOverviewDocument(path)}
                    discardedShotIds={discardedShots}
                    onToggleDiscarded={(shotId, discarded) => {
                      void toggleDiscardedShot(shotId, discarded);
                    }}
                    onMediaPlaced={() => {
                      setRefreshKey((key) => key + 1);
                      setNotice(ui.episodeData.mediaPlaced);
                    }}
                    onMediaChanged={(message) => {
                      setRefreshKey((key) => key + 1);
                      setNotice(message);
                    }}
                  />
                ) : (
                  <div className="empty-editor">
                    ▤<p>{ui.empty}</p>
                  </div>
                )}
                <div className="editor-footer">
                  <span>{ui.statusHint}</span>
                  <span>
                    {text.length.toLocaleString()} 字符 · {board.cards.length}{" "}
                    镜
                  </span>
                </div>
              </section>
            </main>
          )}
        </>
      )}
      {showBatchDialog && project && snapshot && (
        <BatchGenerateDialog
          project={project}
          document={path}
          board={board}
          generationSettings={generationSettings}
          busy={busy}
          onClose={() => setShowBatchDialog(false)}
          onCreated={(message) => {
            setNotice(message);
            void refreshBatchJobs().catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
      {showAudioBatchDialog && project && snapshot && (
        <BatchAudioDialog
          project={project}
          document={path}
          board={board}
          busy={busy}
          onClose={() => setShowAudioBatchDialog(false)}
          onCreated={(message) => {
            setNotice(message);
            void refreshBatchJobs().catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
      {showAudioApiDialog && (
        <AudioApiDialog
          busy={busy}
          onClose={() => setShowAudioApiDialog(false)}
          onSaved={() => {
            setShowAudioApiDialog(false);
            setNotice(ui.audio.settingsSaved);
          }}
        />
      )}
      {showMergeDialog && project && snapshot && (
        <MergeDialog
          project={project}
          document={path}
          board={board}
          busy={busy}
          mergeRunning={episodeMergeRunning}
          discardedShotIds={discardedShots}
          onToggleDiscarded={(shotId, discarded) => {
            void toggleDiscardedShot(shotId, discarded);
          }}
          onLocate={(shotId) => {
            const index = board.cards.findIndex((card) => card.id === shotId);
            setShowMergeDialog(false);
            if (index < 0) return;
            setActiveShot(index);
            // 弹框关闭和故事板重绘后再滚动，避免只更新左侧导航高亮。
            window.setTimeout(() => {
              document
                .getElementById(`shot-card-${index}`)
                ?.scrollIntoView({ block: "start", behavior: "smooth" });
            }, 50);
          }}
          onClose={() => setShowMergeDialog(false)}
          onCreated={(message) => {
            if (message) setNotice(message);
            void refreshBatchJobs().catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
      {(modal || candidates) && (
        <div className="modal-backdrop">
          <section
            className={`modal${modal === "api" ? " api-modal" : ""}`}
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
                        onChange={(event) => {
                          setShowApiToken(false);
                          const nextId = event.target.value;
                          setApiDraft((draft) => ({
                            ...draft,
                            activeProfileId: nextId,
                          }));
                        }}
                      >
                        {apiDraft.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="api-profile-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => addApi()}
                      >
                        {ui.generation.addProfile}
                      </button>
                      {activeApi && (
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={deleteApi}
                        >
                          {ui.generation.deleteProfile}
                        </button>
                      )}
                    </div>
                    <label>
                      {ui.generation.addPreset}
                      <select
                        value=""
                        disabled={busy}
                        onChange={(event) => {
                          const preset = AUTODL_RESOLUTION_PRESETS.find(
                            (item) => item.id === event.target.value,
                          );
                          if (preset) addApi(preset);
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
                    {activeApi ? (
                      <>
                        <label>
                          {ui.generation.platformType}
                          <select
                            value={activeApi.type}
                            disabled={busy}
                            onChange={(event) =>
                              updateApi({
                                type: event.target.value as ApiProfile["type"],
                              })
                            }
                          >
                            {API_PLATFORM_TYPES.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                          <small>{ui.generation.platformTypeHint}</small>
                        </label>
                        <label>
                          {ui.generation.profileName}
                          <input
                            value={activeApi.name}
                            required
                            disabled={busy}
                            onChange={(event) => {
                              const next = fillEmptyAutodlPreset({
                                ...activeApi,
                                name: event.target.value,
                              });
                              updateApi({
                                name: next.name,
                                ...(next.resolutions !== activeApi.resolutions
                                  ? { resolutions: next.resolutions }
                                  : {}),
                                ...(next.defaultSeed !== activeApi.defaultSeed
                                  ? { defaultSeed: next.defaultSeed }
                                  : {}),
                              });
                            }}
                          />
                        </label>
                        <label>
                          {ui.generation.submitUrl}
                          <input
                            autoFocus
                            value={activeApi.submitUrl}
                            onChange={(event) => {
                              const next = fillEmptyAutodlPreset({
                                ...activeApi,
                                submitUrl: event.target.value,
                              });
                              updateApi({
                                submitUrl: next.submitUrl,
                                ...(next.resolutions !== activeApi.resolutions
                                  ? { resolutions: next.resolutions }
                                  : {}),
                                ...(next.defaultSeed !== activeApi.defaultSeed
                                  ? { defaultSeed: next.defaultSeed }
                                  : {}),
                              });
                            }}
                            placeholder={ui.generation.submitUrlPlaceholder}
                            required
                            disabled={busy}
                          />
                          <small>{ui.generation.submitUrlHint}</small>
                        </label>
                        <label>
                          {ui.generation.queryUrl}
                          <input
                            value={activeApi.queryUrl}
                            onChange={(event) =>
                              updateApi({ queryUrl: event.target.value })
                            }
                            placeholder={ui.generation.queryUrlPlaceholder}
                            required
                            disabled={busy}
                          />
                          <small>{ui.generation.queryUrlHint}</small>
                        </label>
                        <div className="api-inline-field">
                          <span>{ui.generation.resolutions}</span>
                          <input
                            value={activeApi.resolutions}
                            onChange={(event) =>
                              updateApi({ resolutions: event.target.value })
                            }
                            placeholder={ui.generation.resolutionsPlaceholder}
                            required
                            disabled={busy}
                            spellCheck={false}
                          />
                        </div>
                        <div className="api-inline-field">
                          <span>{ui.generation.defaultSeed}</span>
                          <input
                            inputMode="numeric"
                            value={activeApi.defaultSeed}
                            onChange={(event) =>
                              updateApi({
                                defaultSeed: event.target.value.replace(
                                  /[^0-9]/g,
                                  "",
                                ),
                              })
                            }
                            placeholder={ui.generation.defaultSeedPlaceholder}
                            disabled={busy}
                          />
                        </div>
                        <div className="api-inline-field">
                          <span>{ui.generation.authorization}</span>
                          <span className="secret-input">
                            <input
                              type={showApiToken ? "text" : "password"}
                              value={activeApiTokenDisplay}
                              readOnly={activeApiTokenReadOnly}
                              onChange={(event) =>
                                setApiAuthorizations((values) => ({
                                  ...values,
                                  [activeApi.id]: event.target.value,
                                }))
                              }
                              placeholder={
                                ui.generation.authorizationPlaceholder
                              }
                              autoComplete="new-password"
                              disabled={busy}
                            />
                            {activeApiHasToken && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={toggleApiToken}
                              >
                                {showApiToken
                                  ? ui.generation.hideToken
                                  : ui.generation.showToken}
                              </button>
                            )}
                          </span>
                        </div>
                      </>
                    ) : (
                      <p className="muted">{ui.generation.noProfiles}</p>
                    )}
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
                          {modal === "project" && (
                            <>
                              <br />
                              {ui.rememberProjectDirectories}
                            </>
                          )}
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
                              aria-describedby={
                                defaultVoiceDirectory
                                  ? "default-voice-directory"
                                  : undefined
                              }
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
                        {defaultVoiceDirectory && (
                          <div className="default-voice-directory">
                            <small id="default-voice-directory">
                              {ui.defaultVoiceDirectory}
                              <span>{defaultVoiceDirectory}</span>
                            </small>
                            <button
                              type="button"
                              disabled={
                                busy || voiceDirectory === defaultVoiceDirectory
                              }
                              onClick={() =>
                                setVoiceDirectory(defaultVoiceDirectory)
                              }
                            >
                              {ui.restoreDefaultVoiceDirectory}
                            </button>
                          </div>
                        )}
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
                            !profile.submitUrl.trim() ||
                            !profile.queryUrl.trim() ||
                            !profile.resolutions.trim() ||
                            !profile.name.trim(),
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
      {pendingRecentRemoval && (
        <div className="modal-backdrop">
          <section
            className="modal confirmation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-recent-title"
          >
            <h2 id="remove-recent-title">{ui.removeRecent}</h2>
            <p>{ui.removeConfirm}</p>
            <div className="confirmation-target">
              <strong>{pendingRecentRemoval.name}</strong>
              <small>
                {pendingRecentRemoval.path.replace(/^\\\\\?\\/, "")}
              </small>
            </div>
            <div className="modal-actions">
              <button
                autoFocus
                disabled={busy}
                onClick={() => setPendingRecentRemoval(null)}
              >
                {ui.cancel}
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  const target = pendingRecentRemoval;
                  void run(async () => {
                    const result = await api.removeRecent(target.path);
                    setRecent(result.recent);
                    setPendingRecentRemoval(null);
                  });
                }}
              >
                {ui.removeConfirmAction}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingRecentRename && (
        <div className="modal-backdrop">
          <section
            className="modal confirmation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-recent-title"
          >
            <h2 id="rename-recent-title">{ui.renameProject}</h2>
            <label>
              {ui.projectName}
              <input
                autoFocus
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={renameFolder}
                onChange={(event) => setRenameFolder(event.target.checked)}
              />
              {ui.renameFolderToo}
            </label>
            <div className="modal-actions">
              <button
                disabled={busy}
                onClick={() => setPendingRecentRename(null)}
              >
                {ui.cancel}
              </button>
              <button
                className="primary-button"
                disabled={busy || !renameName.trim()}
                onClick={() => {
                  const target = pendingRecentRename;
                  void run(async () => {
                    const result = await api.renameRecent(
                      target.path,
                      renameName.trim(),
                      renameFolder,
                    );
                    setRecent(result.recent);
                    setPendingRecentRename(null);
                  });
                }}
              >
                {ui.confirm}
              </button>
            </div>
          </section>
        </div>
      )}
      {unsavedDialog}
    </div>
  );
}
