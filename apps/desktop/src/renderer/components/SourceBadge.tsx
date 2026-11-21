import type { SourceClient } from "@cognelis/decision-protocol";

import { sourceLabel } from "../client-labels.js";

export const SourceBadge = ({ source }: { source: SourceClient }) => (
  <span className={`source-badge source-${source}`}>{sourceLabel(source)}</span>
);
