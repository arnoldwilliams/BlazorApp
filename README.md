# BlazorApp

A .NET 10 Blazor WebAssembly PDF reader that opens and displays PDF files, reads
their contents aloud, and exports the narration as WAV or MP3.

## Features

- **PDF viewing** — PDF.js rendering with paging, zoom and rotation.
- **Text layer** — click a word to read from it, or select a range and read the
  selection.
- **Read aloud** — the Web Speech API, so voices come from the operating system.
- **OCR** — Tesseract.js gives scanned, image-only pages a selectable text layer.
  Pages that already have real text are left alone; a page carrying only a
  scanner stamp or watermark still counts as scanned.
- **Audio export** — save the narration as MP3 or WAV, with a choice of two
  engines (see below).

## Projects

| Project | Purpose |
| --- | --- |
| `PdfReaderApp` | The Blazor WebAssembly reader. |
| `TtsServer` | Optional ASP.NET Core API that narrates with a neural voice. |

## Running the reader

```bash
export PATH="$HOME/.dotnet:$PATH"
cd PdfReaderApp
dotnet run --no-launch-profile --urls "http://0.0.0.0:12000"
```

Then open <http://localhost:12000>. Sample PDFs are in
`PdfReaderApp/wwwroot/samples/`.

## Read aloud vs. export: two engines

Read aloud and audio export cannot share one engine, and this is worth knowing
before wondering why the voices differ.

The Web Speech API that powers read aloud is **playback only**. It speaks to the
sound card and hands back no audio samples, and a web page cannot tap the OS
audio stream. Producing a downloadable file therefore needs an engine that can
render PCM in software.

Export offers both:

- **Offline (built in)** — meSpeak, an eSpeak port compiled to JavaScript. Always
  available, works with no network, but it is a formant synthesiser and sounds
  noticeably robotic.
- **Narrator voice** — the optional `TtsServer`, which synthesises with
  [piper](https://github.com/rhasspy/piper), a neural engine. This is the one to
  use if you want the exported audio to sound like a real narrator. It requires
  the server to be running; if it is not, the reader falls back to the offline
  engine automatically.

## Running the narration server

```bash
export PATH="$HOME/.dotnet:$PATH"
cd TtsServer
./scripts/setup-voices.sh     # downloads the engine and voice models, once
dotnet run --no-launch-profile --urls "http://0.0.0.0:12001"
```

`setup-voices.sh` fetches the piper build for your platform plus the voice models
the server offers. They are large and platform specific, so they are not
committed — the script is the way to get them. To install a subset, name the
voices:

```bash
./scripts/setup-voices.sh en_US-lessac-medium de_DE-thorsten-medium
```

The reader looks for the server at `NarrationServer:BaseUrl` in
`PdfReaderApp/wwwroot/appsettings.json`, which defaults to
`http://localhost:12001`. If the server runs elsewhere, change that value and the
matching `Cors:Origins` entry in `TtsServer/appsettings.json`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Whether the engine is installed and how many voices are available. |
| `GET /api/voices` | The installed voices. |
| `POST /api/speech` | `{ text, voice, rate, sentenceSilenceMs }` → a WAV. |
