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
