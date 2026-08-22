# ADR 0008: Forward Discord attachments as bounded OpenCode FileParts

Status: Accepted

## Context

The MVP rejected every Discord attachment. Phase 2 needs file input without turning Discord into a filesystem upload surface or introducing arbitrary URL fetching.

OpenCode 1.18.20 and current OpenCode share the same `FilePart` shape:

- `type: "file"`
- `mime`
- optional `filename`
- `url`

The OpenCode UI already uses data URLs for in-memory image attachments. V1 also treats `text/plain` file parts as textual prompt context rather than arbitrary provider media.

## Decision

Discord attachments are accepted only for authorized messages in an existing bound thread and are converted in memory to OpenCode FileParts.

The bridge does not write attachment bytes to the host filesystem.

### Download boundary

Only the attachment URL supplied by Discord's message object is used. User message text is never interpreted as an attachment URL.

The URL must:

- use HTTPS;
- use `cdn.discordapp.com` or `media.discordapp.net`;
- use a `/attachments/` path;
- complete without an HTTP redirect.

Redirect following is disabled so a Discord CDN URL cannot become a generic SSRF primitive.

### Limits

A prompt may contain at most four attachments, at most 10 MiB each, and at most 20 MiB total.

Discord metadata is checked before download. HTTP `Content-Length` and the actual downloaded byte count are also bounded before the prompt is sent.

All attachments are prepared before `session.promptAsync()` is called. If any attachment fails validation or download, no partial prompt is sent.

### Supported payloads

Direct media FileParts are limited to:

- PNG;
- JPEG;
- WebP;
- GIF;
- PDF.

Their declared MIME type must agree with a simple file signature check.

UTF-8 text-like attachments are normalized to `text/plain` while preserving a sanitized filename. Explicit `text/*`, JSON, XML, and YAML MIME types are text-like. If Discord supplies no MIME type, an attachment may still be accepted when it passes strict UTF-8 decoding and basic binary-control checks.

Archives, executables, arbitrary `application/octet-stream`, unsupported MIME types, invalid UTF-8 unknown files, and media/signature mismatches are rejected.

### Filename handling

Filenames are metadata only. They are never used as filesystem paths. Path components and control characters are removed and the result is length-bounded.

### Ask and busy semantics

A pending OpenCode Ask remains text-only. A Discord message with attachments while an Ask is pending is rejected rather than accidentally becoming either an Ask answer or a normal prompt.

The bridge checks OpenCode session busy/retry state before downloading attachment bytes.

## Consequences

- Discord can send image, PDF, and text-like context into the same OpenCode session as the TUI.
- No host upload directory, cleanup lifecycle, or archive extraction is introduced.
- Data URLs increase transient memory usage, which is bounded by the attachment limits.
- Models/providers can still reject a valid media type they do not support; that remains an OpenCode/model capability issue rather than a reason to broaden Bridge authority.
- OpenCode-to-Discord generated file delivery is intentionally outside this ADR and should be validated separately before implementation.
