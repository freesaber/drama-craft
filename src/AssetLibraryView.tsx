import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { checkAssetSource, parseAssetIndex, searchAssets } from "./assetIndex";
import type { AssetEntry, AssetIndexResult, AssetType } from "./assetIndex";
import type { DocumentEntry, Project } from "./types";
import { ui } from "./i18n";
import { parseStoryboard } from "./storyboard";

const typeNames: Record<AssetType, string> = ui.assetIndex.types;

export default function AssetLibraryView({
  project, documents, onOpen, onBack,
}: {
  project: Project;
  documents: DocumentEntry[];
  onOpen: (path: string) => void;
  onBack: () => void;
}) {
  const [index, setIndex] = useState<AssetIndexResult | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [selected, setSelected] = useState<AssetEntry | null>(null);
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);
  const [sourceDetails, setSourceDetails] = useState<{ file: string | null; voice: string | null; prompt: string } | null>(null);
  const [sourceStatus, setSourceStatus] = useState<"idle" | "checking" | "checked">("idle");
  const selectionVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const raw = await api.assetIndex(project.handle);
      setIndex(parseAssetIndex(raw, documents.map((doc) => doc.path)));
      setSelected(null);
      setSourceErrors([]);
      setSourceDetails(null);
      setSourceStatus("idle");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [project.handle, documents]);
  const matches = useMemo(
    () => searchAssets(index?.assets ?? [], query, type),
    [index, query, type],
  );
  const select = async (asset: AssetEntry) => {
    const version = ++selectionVersion.current;
    setSelected(asset);
    setSourceErrors([]);
    setSourceDetails(null);
    setSourceStatus("checking");
    if (!documents.some((doc) => doc.path === asset.firstDocument)) {
      setSourceErrors([`${asset.firstDocument} 不在项目文档中。`]);
      setSourceStatus("checked");
      return;
    }
    try {
      const source = await api.read(project.handle, asset.firstDocument);
      if (version === selectionVersion.current) {
        setSourceErrors(checkAssetSource(asset, source.text));
        const episode = parseStoryboard(source.text).episode;
        if (asset.type === "character") {
          const row = episode.characters.find((item) => item.id === asset.id);
          if (row) setSourceDetails({ file: row.image, voice: row.voice, prompt: row.imagePrompt });
        } else {
          const row = episode.assets.find((item) => item.id === asset.id);
          if (row) setSourceDetails({ file: row.reference, voice: null, prompt: row.prompt });
        }
      }
    } catch (cause) {
      if (version === selectionVersion.current) setSourceErrors([errorMessage(cause)]);
    } finally {
      if (version === selectionVersion.current) setSourceStatus("checked");
    }
  };
  return (
    <main className="asset-library-view">
      <header className="asset-library-header">
        <div><h2>{ui.assetIndex.title}</h2><p>{ui.assetIndex.summary}</p></div>
        <div><button onClick={() => void load()} disabled={loading}>{ui.assetIndex.refresh}</button><button onClick={onBack}>{ui.assetIndex.back}</button></div>
      </header>
      {error && <p role="alert" className="banner conflict">{error}</p>}
      {index?.missing && <p>{ui.assetIndex.missing}</p>}
      {index && !index.missing && <>
        {index.diagnostics.length > 0 && <div className="asset-index-diagnostics" role="alert">
          <strong>{ui.assetIndex.diagnostics(index.diagnostics.length)}</strong>
          <ul>{index.diagnostics.map((message, i) => <li key={i}>{message}</li>)}</ul>
        </div>}
        <div className="asset-library-filters">
          <input aria-label={ui.assetIndex.search} placeholder={ui.assetIndex.search} value={query} onChange={(event) => setQuery(event.target.value)} />
          <select aria-label={ui.assetIndex.type} value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">{ui.assetIndex.allTypes}</option>
            {Object.entries(typeNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <span>{ui.assetIndex.results(matches.length)}</span>
        </div>
        <div className="asset-library-results">
          <div className="asset-library-list">
            {matches.slice(0, 100).map((asset) => <button key={`${asset.id}-${asset.firstDocument}`} onClick={() => void select(asset)} className={selected === asset ? "selected" : ""}>
              <code>{asset.id}</code> <strong>{asset.name}</strong> <small>{typeNames[asset.type]} · {asset.firstDocument}</small>
            </button>)}
            {matches.length > 100 && <p>{ui.assetIndex.limit}</p>}
            {!matches.length && <p>{ui.assetIndex.noMatch}</p>}
          </div>
          {selected && <section className="asset-library-detail">
            <h3>{selected.name} <code>{selected.id}</code></h3>
            <p>{ui.assetIndex.type}：{typeNames[selected.type]}</p>
            <p>{ui.assetIndex.aliases}：{selected.aliases.join("、") || "—"}</p>
            <p>{ui.assetIndex.keywords}：{selected.keywords.join("、") || "—"}</p>
            <p>{ui.assetIndex.firstDocument}：{selected.firstDocument}</p>
            {selected.baseId && <p>{ui.assetIndex.baseId}：{selected.baseId}</p>}
            {sourceDetails && <>
              <p>{ui.assetIndex.file}：<code>{sourceDetails.file || "—"}</code></p>
              {selected.type === "character" && <p>{ui.assetIndex.voice}：<code>{sourceDetails.voice || "—"}</code></p>}
              {sourceDetails.prompt && <details><summary>{ui.assetIndex.prompt}</summary><pre>{sourceDetails.prompt}</pre></details>}
            </>}
            {sourceStatus === "checking" ? <p>{ui.assetIndex.checking}</p> :
              sourceErrors.length ? <ul role="alert">{sourceErrors.map((message) => <li key={message}>{message}</li>)}</ul> :
                sourceStatus === "checked" ? <p>{ui.assetIndex.checked}</p> : null}
            <button disabled={!documents.some((doc) => doc.path === selected.firstDocument)} onClick={() => onOpen(selected.firstDocument)}>{ui.assetIndex.openFirst}</button>
          </section>}
        </div>
      </>}
    </main>
  );
}
