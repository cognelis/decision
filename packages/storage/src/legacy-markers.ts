const CURRENT_MARKER_PREFIX = "<!-- decision:";
const LEGACY_MARKER_PREFIX = "<!-- decision-island:";

export const normalizeLegacyDecisionMarkers = (markdown: string): string =>
  markdown.replace(
    /(?<!\\)<!-- decision-island:/gu,
    CURRENT_MARKER_PREFIX,
  );

export const escapeDecisionMarkerText = (value: string): string =>
  value
    .replaceAll(CURRENT_MARKER_PREFIX, `\\${CURRENT_MARKER_PREFIX}`)
    .replaceAll(LEGACY_MARKER_PREFIX, `\\${LEGACY_MARKER_PREFIX}`);

export const unescapeDecisionMarkerText = (value: string): string =>
  value
    .replaceAll(`\\${CURRENT_MARKER_PREFIX}`, CURRENT_MARKER_PREFIX)
    .replaceAll(`\\${LEGACY_MARKER_PREFIX}`, LEGACY_MARKER_PREFIX);
