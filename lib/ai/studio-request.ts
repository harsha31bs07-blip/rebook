// Delegated Page/Widget turns contain live schemas, report state and tool results (50+ KiB).
// Keep one byte ceiling for both wire contracts, including direct schema callers.
export const STUDIO_REQUEST_BYTES = 262_144;
export const studioRequestFits = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).byteLength <= STUDIO_REQUEST_BYTES;
export const STUDIO_REQUEST_TOO_LARGE = "This conversation is too large. Please start a new conversation.";
