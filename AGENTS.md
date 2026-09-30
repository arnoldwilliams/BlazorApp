# AGENTS.md

## Project

`PdfReaderApp` — a .NET 10 Blazor WebAssembly PDF reader with read-aloud support.
Located in `PdfReaderApp/`.

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
  Implements `IReadAloudHost` and acts as the JS interop host.
- `Pages/PdfPageView.razor` — one page: canvas + PDF.js text layer. Receives
  span offsets and the active highlight as parameters.
- `Services/PdfInterop.cs` — C# wrapper over `wwwroot/js/pdfInterop.js`.
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
