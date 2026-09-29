# AGENTS.md

## Project

`PdfReaderApp` — a .NET 10 Blazor WebAssembly document reader with read-aloud
support. It opens PDF and Word (`.docx`) files. Located in `PdfReaderApp/`.

## Build and run

```bash
export PATH="$HOME/.dotnet:$PATH"
cd PdfReaderApp
dotnet build
dotnet run --no-launch-profile --urls "http://0.0.0.0:12000"
```

- The SDK lives in `~/.dotnet`, so `dotnet` needs that on `PATH`.
- `wwwroot` static assets are copied into the WASM output at build time. After
  editing anything under `wwwroot/` (JS, CSS, html) you must rebuild before the
  running server serves the new version. Editing a `wwwroot` file alone is not
  picked up by an already-running `dotnet run`.
- There is no test project; verify in a browser. `playwright` and `chromium` are
  available (`/usr/bin/chromium`, launch with `--no-sandbox`).

## Architecture

- `Pages/Viewer.razor` — document open, toolbar, sidebar, read-aloud controls.
  Implements `IReadAloudHost` and acts as the JS interop host. Picks the engine
  for the opened file and points `ActiveDocumentSource` at it.
- `Pages/DocumentPageView.razor` — one page: a canvas for the PDF engine plus the
  engine's text layer. Receives span offsets and the active highlight as
  parameters. The text layer class differs per format (`textLayer` for pdf.js,
  `document-layer` for flow content).
- `Models/DocumentModels.cs` — shared document/page/span/chunk models plus the
  `DocumentFormat` enum.
- `Services/DocumentEngine.cs` — the engine abstraction. `IDocumentEngine` covers
  open/render/text/highlight/release; `IDocumentTextSource` is the subset the
  read-aloud controller uses; `ActiveDocumentSource` forwards to the engine that
  is currently showing a document.
- `Services/PdfInterop.cs` — PDF engine, C# wrapper over `wwwroot/js/pdfInterop.js`.
- `Services/DocxInterop.cs` — DOCX engine, C# wrapper over `wwwroot/js/docxInterop.js`
  (mammoth.js under `wwwroot/lib/mammoth`).
- `Services/SpeechInterop.cs` — wrapper over `wwwroot/js/speechInterop.js`
  (Web Speech API).
- `Services/ReadAloudController.cs` — chunking, playback state, highlight ranges.
- `Services/TextChunker.cs` — splits page text into speakable passages.
- `Services/AudioExportService.cs` — wrapper over `wwwroot/js/audioExport.js`,
  which renders passages to WAV/MP3 files offline.

## Audio export

The Web Speech API only plays audio and cannot return samples, so export uses a
separate engine bundled under `wwwroot/lib`:

- `lib/mespeak` — meSpeak.js (eSpeak compiled to JS). `meSpeak.speak(text,
  { rawdata: 'array' }, cb)` returns raw PCM inside a RIFF/WAV container.
- `lib/lamejs` — `lame.min.js`, encodes that PCM to MP3.

`wwwroot/js/audioExport.js` loads both scripts lazily, synthesises each passage,
optionally inserts silence between passages, and hands back a blob URL.

Option units matter: meSpeak's `speed` is words per minute (default 175),
`pitch` is 0–99 and `amplitude` is 0–200. Passing `1.0` for all three (as if they
were multipliers) produces near-inaudible, drawn-out audio that still has a
non-zero byte length, so size checks alone will not catch it. `toEngineOptions`
converts the UI multipliers into these ranges.

Voice files are resolved by meSpeak relative to the directory of its own script,
so paths are written as `voices/en/en-us.json`, not `./lib/mespeak/voices/...`.
A doubled path is a 404 and surfaces as an opaque "file error" from the worker.

## DOCX support

Word files are converted to HTML in the browser with mammoth.js and paginated
client side so they reuse the same page model as PDFs:

- `wwwroot/js/docxInterop.js` converts the file, splits the body into top level
  blocks (a list is split per item so a long list can span pages), then measures
  each block with an off screen element to decide where pages break. Blocks are
  wrapped in numbered `span[data-num]` elements so click-to-read and highlighting
  share the PDF offset model.
- The measuring element and the rendered pages both use the `document-content`
  class. Their typography must stay identical or measured heights will not match
  what is drawn and content will overflow or leave gaps.
- Pages are letter sized (816x1056 CSS px) and scaled with `transform` to the
  requested zoom and rotation, so pagination is computed once at 100% and reflow
  is unnecessary on zoom.
- The converted HTML is sanitised before insertion: script-like tags are removed
  and inline event handlers / `javascript:` URLs are stripped.

## Gotchas

- pdf.js 6.x exposes `destroy` on the loading task, not on `PDFDocumentProxy`.
  `wwwroot/js/pdfInterop.js` calls `doc.loadingTask.destroy()` with a fallback to
  `doc.destroy()`, since older builds had the latter.
- A Blazor method invoked from JS via `invokeMethodAsync` must carry
  `[JSInvokable]` on the concrete method, not only on the interface it
  implements.
- JS interop method signatures must match between C# and JS. Pass only what the
  JS function declares — extra or missing leading arguments shift everything
  (an `ElementReference` arriving where a string is expected) and the mismatch
  fails silently.
- PDF.js text items and speech chunk ranges share one character-offset model.
  Span offsets are computed once and reused for both click-to-read and
  highlighting, so changing one requires changing the other.
