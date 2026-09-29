# BlazorApp

A .NET 10 Blazor WebAssembly document reader. Opens PDF and Word (`.docx`)
files, renders them page by page, reads them aloud with the browser's Web
Speech API, highlights the passage being spoken, and exports the spoken audio
as WAV or MP3 — all client side.

- Application: [`PdfReaderApp/`](PdfReaderApp/)
- Technical architecture (use case, class and sequence diagrams):
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Working notes and conventions: [`AGENTS.md`](AGENTS.md)
