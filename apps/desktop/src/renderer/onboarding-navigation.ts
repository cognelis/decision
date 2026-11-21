/**
 * Opens the assistant on a new 接入新工具 conversation, from any page (the 接入 page's own button among them): App
 * listens for it, as it opens a conversation picked in quick jump.
 */
export const START_ONBOARDING_EVENT = "decision:start-onboarding";

export const startOnboarding = (): void => {
  window.dispatchEvent(new Event(START_ONBOARDING_EVENT));
};
