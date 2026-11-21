/** The list the 待办 page has open, for the global 快速添加: set by the page while it shows a list, cleared when it goes. */
let current: string | null = null;

export const setTodoViewContext = (listId: string | null): void => {
  current = listId;
};

export const getTodoViewContext = (): string | null => current;
