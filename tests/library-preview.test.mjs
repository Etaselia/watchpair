import assert from "node:assert/strict";
import test from "node:test";

import {
  isLibraryPreviewJobId,
  libraryPreviewNeedsHls,
} from "../lib/library-preview.mjs";

test("library preview chooses HLS for containers Chromium cannot reliably decode", () => {
  for (const name of ["movie.mkv", "MOVIE.AVI", "recording.ts"]) {
    assert.equal(libraryPreviewNeedsHls(name), true, name);
  }
  for (const name of ["movie.mp4", "clip.webm", "archive.mkv.txt", "unknown"]) {
    assert.equal(libraryPreviewNeedsHls(name), false, name);
  }
});

test("only isolated UUID preview jobs use the reserved client prefix", () => {
  assert.equal(isLibraryPreviewJobId("preview-123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isLibraryPreviewJobId("preview-room-source"), false);
  assert.equal(isLibraryPreviewJobId("local-123e4567-e89b-12d3-a456-426614174000"), false);
});
