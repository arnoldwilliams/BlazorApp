# AGENTS.md

## Project

`PdfReaderApp` — a .NET 10 Blazor WebAssembly PDF reader with read-aloud support.
Located in `PdfReaderApp/`.

`TtsServer` — an optional ASP.NET Core API that narrates text with a neural voice.
Located in `TtsServer/`. The reader works without it.

## Build and run

```bash
export PATH="$HOME/.dotnet:$PATH"

# The reader
cd PdfReaderApp
dotnet build
dotnet run --no-launch-profile --urls "http://0.0.0.0:12000"

# The narration server (optional)
cd TtsServer
./scripts/setup-voices.sh          # once, downloads the engine and voices
dotnet run --no-launch-profile --urls "http://0.0.0.0:12001"
```

- The SDK lives in `~/.dotnet`, so `dotnet` needs that on `PATH`.
- `BlazorApp.slnx` at the repository root covers both projects.
- `wwwroot` static assets are copied into the WASM output at build time. After
  editing anything under `wwwroot/` (JS, CSS, html) you must rebuild before the
  running server serves the new version. Editing a `wwwroot` file alone is not
  picked up by an already-running `dotnet run`.
- There is no test project; verify in a browser. `playwright` and `chromium` are
  available (`/usr/bin/chromium`, launch with `--no-sandbox`). Ready-made
  Playwright checks live in `tests/`; see `tests/README.md`. Note that
  `test_narration_fallback.py` requires the narration server to be *stopped* and
  `test_narration_server.py` requires it to be *running*.

## Architecture

- `Pages/Viewer.razor` — document open, toolbar, sidebar, read-aloud controls.
  Implements `IReadAloudHost` and acts as the JS interop host.
- `Pages/PdfPageView.razor` — one page: canvas + PDF.js text layer. Receives
  span offsets and the active highlight as parameters.
- `Services/PdfInterop.cs` — C# wrapper over `wwwroot/js/pdfInterop.js`.
- `Services/SpeechInterop.cs` — wrapper over `wwwroot/js/speechInterop.js`
  (Web Speech API).
- `Services/ReadAloudController.cs` — chunking, playback state, highlight ranges.
- `Services/TextChunker.cs` — splits page text into speakable passages.
- `Services/AudioExportService.cs` — wrapper over `wwwroot/js/audioExport.js`,
  which renders passages to WAV/MP3 files.
- `Services/NarrationServerClient.cs` — wrapper over the narration server API,
  including the health probe that decides whether it can be offered.
- `TtsServer/` — the optional narration API (`Program.cs`), the voice catalog
  shared with the reader (`VoiceCatalog.cs`) and the piper subprocess wrapper
  (`PiperEngine.cs`).

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

### Why there are two engines

Live reading and export use different engines, and the voices therefore do not
match unless the narration server is used:

- Read aloud uses the **Web Speech API**. Its voices come from the operating
  system, so they are the good neural ones, but the API is playback only. It
  gives no audio buffer and there is no way to capture one from a web page.
- Export must produce a file, so it needs an engine that can return samples.
  The bundled meSpeak can, but it is a formant synthesiser and sounds robotic.

`AudioExportEngine.Server` closes that gap by asking `TtsServer` to synthesise
each passage with piper, a neural engine, and returning WAV to the browser. The
browser still does the assembly and MP3 encoding, so the server never needs an
encoder.

The server is optional, and the reader must keep working without it:

- `NarrationServerClient.ProbeAsync` hits `/api/health` on startup. If it fails,
  the narrator option is shown as unavailable and disabled, and the export panel
  falls back to `Offline`.
- A probe against a stopped server logs `ERR_CONNECTION_REFUSED` in the browser
  console. That is the browser reporting the failed fetch, not an application
  error; no exception escapes.
- `synthesizeServer` throws a plain `Error` with a readable message for non-2xx
  responses, which `StartExport` turns into a status message.

The two engines have unrelated voice ids, so the voice dropdown is rebuilt when
the engine changes rather than merged. `TtsServer/VoiceCatalog.cs` is the single
source of truth for server voice ids; the reader never hardcodes them.

`wwwroot/appsettings.json` holds `NarrationServer:BaseUrl`. Point it at wherever
the server runs. CORS on the server must allow the reader's origin
(`Cors:Origins` in `TtsServer/appsettings.json`).

## OCR (scanned pages)

`Services/OcrService.cs` drives Tesseract.js (vendored under `wwwroot/lib/tesseract`)
through `wwwroot/js/ocr.js` to give scanned, image-only pages a selectable text
layer. Results are stored as a page text override in `pdfInterop.js`, so the rest
of the app (read-aloud, highlight, export) treats an OCR page like any other.

Coordinate spaces are the whole game here, and there are three of them:

- The image Tesseract was given, in pixels.
- The page's own PDF coordinate space, in points, measured from the bottom left.
- The displayed page, in CSS pixels, which is the page scaled and rotated.

`buildOcrPageModel` converts recognised pixel boxes into the page's own space with
`viewport.convertToPdfPoint`, and `renderOcrTextLayer` converts them back to the
displayed space with `viewport.convertToViewportPoint`. Storing boxes in page
space is what makes them survive rotation and zoom; storing them as fractions of
the image does not, because the image axes do not line up with the page axes once
the page is rotated.

- `getPageViewport` must return the real pdf.js `PageViewport`. Its conversion
  methods are the point; a plain object with the same width and height throws
  "not a function" at the first conversion.
- Recognition always runs at rotation 0. Tesseract cannot read sideways text, so
  the viewer's rotation is applied afterwards when the boxes are mapped back.
- `renderOcrTextLayer` takes the caller's `scale`. Hardcoding `1` leaves the layer
  laid out for an unzoomed page and the spans drift as soon as the page is zoomed.

## Deciding whether a page is scanned

The default OCR scope recognises "pages that have no text layer", and that decision is
made per page from `getPageText` in `pdfInterop.js`. A page is only treated as already
having text when the extracted glyph boxes cover at least `MinimumTextCoverage` (1%) of
the page and yield at least `MinimumTextCharacters` (25) characters.

Testing for "some text" instead is wrong, and it is the bug this replaced. Scanners and
PDF tools leave a stamp, page number, header or watermark on an otherwise image-only
page. Those few characters are real text, so a non-empty check passes and the page is
skipped, while the genuinely scanned pages around it are recognised. The symptom is an
OCR run that misses the first page and works everywhere else.

The coverage ratio separates the two cleanly, because pdf.js reports each text item's
`width` and `height` already in page units, the same space the scale 1 viewport uses, so
the glyph boxes are summed directly against the page area. Measured on the sample
documents: a scanner stamp covers 0.13%, two or three lines of real text cover 1.5-1.7%,
and a page of prose covers 6.5%. Do not push these values back through the viewport
transform; that scales them a second time and every page clamps to 100%.

## Line breaks and the pause between passages

Each passage is a separate `SpeechSynthesisUtterance`, and the browser inserts a
noticeable pause at the end of every one. A line break is therefore not a pause
in its own right: if a line break ends an utterance, a sentence that merely
wrapped at the edge of the page is read as though it ended in a full stop.

Two things keep that from happening, and they have to agree:

- `buildPageModel` and `buildOcrPageModel` insert a `\n` between lines only when
  the line actually ended a sentence (`textSeparator` in `pdfInterop.js`). A
  wrap inside a sentence is joined with a space instead.
- `TextChunker` does not treat `\n` as a split point. Its terminators are real
  punctuation only.

Changing either one alone is not enough. Dropping the chunker rule leaves the
newlines splitting passages; dropping the separator rule leaves the chunker
splitting on the newlines it is still being handed.

The chunker never rewrites text, it only chooses split points, so a `\n` that
reaches it is spoken as a break regardless of what it meant on the page.

## Gotchas

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
