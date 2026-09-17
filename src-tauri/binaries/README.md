FFmpeg sidecar binaries are downloaded from the pinned lock file, not committed.

```powershell
npm run ffmpeg:download
```

`ffmpeg.lock.json` records the version, artifact URL and SHA-256. The Windows essentials build is invoked as a sibling executable, never linked into the client.

Zip archives are written to the system temp directory so they do not retrigger `tauri dev` file watching. `src-tauri/.taurignore` excludes this folder.
