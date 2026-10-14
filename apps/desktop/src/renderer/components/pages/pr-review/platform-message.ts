/** A platform's own explanation, without the wrapper Electron puts around errors from the main process. */
export const platformMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/u, "") : fallback;
