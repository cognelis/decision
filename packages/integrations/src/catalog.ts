import { CLIENT_CATALOG } from "@cognelis/decision-protocol";

import { BUILT_IN_CLIENTS, clientSummary, type ClientDescriptor, type ClientSummary } from "./clients.js";
import { customClientDescriptor } from "./custom-clients.js";

/** The catalog's tools, as the registry describes the built-in ones. */
export const CATALOG_CLIENTS: readonly ClientDescriptor[] = CLIENT_CATALOG.map(({ client, installNote }) => ({
  ...customClientDescriptor(client),
  ...(installNote === undefined ? {} : { installNote }),
}));

/** Every client Paraself ships, in the order a client's id is looked up: those written in code, then the catalog's. */
export const KNOWN_CLIENTS: readonly ClientDescriptor[] = [...BUILT_IN_CLIENTS, ...CATALOG_CLIENTS];

/** What the renderer is told of the catalog's tools: each marked untested, with why. */
export const catalogSummaries = (): ClientSummary[] =>
  CLIENT_CATALOG.map(({ untested }, index) => ({ ...clientSummary(CATALOG_CLIENTS[index]!), untested }));
