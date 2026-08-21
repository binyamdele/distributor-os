/**
 * Upload validation.
 *
 * Payment evidence is untrusted content arriving from a browser, so the browser's opinion of
 * what it is counts for nothing. Everything below is decided from the bytes.
 *
 * The accepted set is deliberately narrow — JPEG, PNG, PDF — because that is what a photograph
 * of a bank slip actually is. Excluded, with reasons, because "we might as well allow it" is how
 * upload handlers become the vulnerable part of a product:
 *
 *   SVG      is a document that executes script when rendered
 *   HTML     the same, more obviously
 *   archives hide their contents from every check performed here
 *   Office   carries macros
 *   anything executable, for reasons that need no explanation
 */

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** 10 MB. A phone photograph of a slip is well under this; a video is not evidence. */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<AllowedMimeType, readonly string[]>> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'application/pdf': ['.pdf'],
};

export type UploadProblem =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'CONTENT_MISMATCH'
  | 'EXTENSION_MISMATCH';

export interface UploadVerdict {
  readonly ok: boolean;
  readonly problem: UploadProblem | null;
  /** The type decided from the bytes. Null when the bytes match nothing supported. */
  readonly detectedMimeType: AllowedMimeType | null;
  readonly message: string;
}

/**
 * Identifies a file from its leading bytes.
 *
 * Deliberately not a general-purpose sniffing library: three formats, three signatures, no
 * heuristics. A file whose magic bytes are not one of these is refused, which is the correct
 * outcome for anything a payment-evidence upload should be receiving.
 */
export function detectMimeType(bytes: Uint8Array): AllowedMimeType | null {
  if (bytes.length < 8) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => bytes[index] === byte)) return 'image/png';

  // PDF: "%PDF-"
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (pdf.every((byte, index) => bytes[index] === byte)) return 'application/pdf';

  return null;
}

/**
 * Validates an upload against the bytes, the claimed type and the filename.
 *
 * All three must agree. A PNG renamed `.pdf` is refused not because it is dangerous in itself
 * but because something is wrong with the request, and the safe response to "something is wrong"
 * on a file upload is to stop.
 */
export function validateEvidenceUpload(input: {
  bytes: Uint8Array;
  claimedMimeType?: string | null;
  filename?: string | null;
}): UploadVerdict {
  if (input.bytes.byteLength === 0) {
    return {
      ok: false,
      problem: 'EMPTY',
      detectedMimeType: null,
      message: 'That file is empty.',
    };
  }

  if (input.bytes.byteLength > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      problem: 'TOO_LARGE',
      detectedMimeType: null,
      message: `Evidence must be under ${MAX_EVIDENCE_BYTES / (1024 * 1024)} MB.`,
    };
  }

  const detected = detectMimeType(input.bytes);
  if (!detected) {
    return {
      ok: false,
      problem: 'UNSUPPORTED_TYPE',
      detectedMimeType: null,
      message: 'Evidence must be a JPEG, a PNG or a PDF.',
    };
  }

  // The browser's claim is checked against the bytes rather than believed.
  if (input.claimedMimeType && input.claimedMimeType !== detected) {
    return {
      ok: false,
      problem: 'CONTENT_MISMATCH',
      detectedMimeType: detected,
      message: `This file says it is ${input.claimedMimeType} but its contents are ${detected}.`,
    };
  }

  if (input.filename) {
    const extension = input.filename.slice(input.filename.lastIndexOf('.')).toLowerCase();
    if (extension && !EXTENSIONS[detected].includes(extension)) {
      return {
        ok: false,
        problem: 'EXTENSION_MISMATCH',
        detectedMimeType: detected,
        message: `A ${detected} file should not be named "${extension}".`,
      };
    }
  }

  return { ok: true, problem: null, detectedMimeType: detected, message: 'Accepted.' };
}
