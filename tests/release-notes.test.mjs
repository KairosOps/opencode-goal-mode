import test from "node:test";
import assert from "node:assert/strict";
import { extractReleaseNotes } from "../scripts/release-notes.mjs";

test("release notes ignore non-version h2 headings inside a version section", () => {
  const changelog = `# Changelog

## v1.2.3

### Added

- First line.

## Validation

- This h2 is part of the release notes, not a release boundary.

## v1.2.2

- Previous release.
`;

  const body = extractReleaseNotes(changelog, "1.2.3");

  assert.match(body, /First line/);
  assert.match(body, /Validation/);
  assert.match(body, /This h2 is part of the release notes/);
  assert.doesNotMatch(body, /Previous release/);
});

test("release notes accept a leading v in the requested version", () => {
  assert.equal(extractReleaseNotes("## v1.2.3\n\n- Released", "v1.2.3"), "- Released");
});
