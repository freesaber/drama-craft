import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errorMessage } from "./api";
import { ui } from "./i18n";
import type { Media, Project } from "./types";

export function Asset({
  project,
  document,
  reference,
  refreshKey,
  hero = false,
  onAvailability,
}: {
  project: Project;
  document: string;
  reference: string;
  refreshKey: number;
  hero?: boolean;
  onAvailability?: (exists: boolean) => void;
}) {
  const [media, setMedia] = useState<Media | null>(null);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const availabilityCallback = useRef(onAvailability);
  availabilityCallback.current = onAvailability;
  useEffect(() => {
    let active = true;
    setMedia(null);
    setError("");
    setFailed(false);
    api
      .media(project.handle, document, reference)
      .then((value) => {
        if (active) {
          setMedia(value);
          availabilityCallback.current?.(value.exists);
        }
      })
      .catch((e) => {
        if (active) {
          setError(errorMessage(e));
          availabilityCallback.current?.(false);
        }
      });
    return () => {
      active = false;
    };
  }, [project.handle, document, reference, refreshKey]);
  const src = media?.path ? convertFileSrc(media.path) : "";
  return (
    <article className="asset-card">
      <div className="asset-name" title={reference}>
        {reference.replace(/.*[/\\]/, "")}
      </div>
      <div className="asset-path" title={reference}>
        {reference}
      </div>
      {error && <p className="warning-text">{error}</p>}
      {media && (
        <>
          <span className={`asset-state ${media.exists ? "" : "missing"}`}>
            {media.exists ? ui.available : ui.missing}
          </span>
          {hero && !media.exists && (
            <div className="media-placeholder">
              <span>▧</span>
              {ui.missing}
            </div>
          )}
          {src &&
            !failed &&
            (media.kind === "image" ? (
              <img
                src={src}
                alt={reference}
                onError={() => {
                  setFailed(true);
                  availabilityCallback.current?.(false);
                }}
              />
            ) : media.kind === "audio" ? (
              <audio
                src={src}
                controls
                preload="none"
                onError={() => setFailed(true)}
              />
            ) : (
              <video
                src={src}
                controls
                preload="none"
                onError={() => setFailed(true)}
              />
            ))}
          {failed && <p className="warning-text">{ui.decodeError}</p>}
          {media.exists && (
            <button
              className="text-button"
              onClick={() =>
                void api
                  .openMedia(project.handle, document, reference)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              {ui.openFile} ↗
            </button>
          )}
        </>
      )}
    </article>
  );
}
export default function Preview({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Links and images are inert here. Only the local asset panel requests media.
          a: ({ children }) => (
            <span className="document-link">{children}</span>
          ),
          img: ({ alt }) => (
            <span className="image-placeholder">▧ {alt || ui.assets}</span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
