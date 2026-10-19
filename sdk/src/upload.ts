/// <reference lib="dom" />
import { CommunityApiError } from "./errors.js";
import type { LocalImage, UploadTicket } from "./types.js";

/** Sends one file to the storage provider with a signed ticket. Replaceable (tests, other runtimes). */
export type FileUploader = (input: {
  ticket: UploadTicket;
  image: LocalImage;
  /** Bytes sent so far and in total, for a progress bar. */
  onProgress: (sent: number, total: number) => void;
  signal?: AbortSignal;
}) => Promise<void>;

/**
 * The default uploader. It uses XMLHttpRequest because that is the only way to get upload progress in React Native
 * (`fetch` has none), and it appends the file as `{ uri, name, type }`, which React Native's FormData streams from disk.
 */
export const xhrUploader: FileUploader = ({ ticket, image, onProgress, signal }) =>
  new Promise<void>((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.fields)) form.append(key, String(value));
    form.append(ticket.fileField, {
      uri: image.uri,
      name: image.name ?? "photo",
      type: image.mimeType,
    } as unknown as Blob);

    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(new CommunityApiError("The image could not be uploaded. Please try again.", xhr.status, "upload_failed"));
    };
    xhr.onerror = () =>
      reject(new CommunityApiError("Could not reach the server. Check your connection.", 0, "network_error"));
    xhr.ontimeout = () => reject(new CommunityApiError("The upload took too long. Please try again.", 0, "timeout"));
    xhr.timeout = 120_000;

    const onAbort = () => {
      xhr.abort();
      reject(new CommunityApiError("Request cancelled", 0, "aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(form);
  });
