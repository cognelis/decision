import type { TodoDependencyView, TodoItemStatus, TodoItemView } from "@cognelis/decision-protocol";

interface DependencyItem {
  number: number;
  title: string;
  status: TodoItemStatus;
  id?: string | undefined;
  dependsOn?: readonly string[] | undefined;
  dependencyTitles?: Readonly<Record<string, string>> | undefined;
}
interface DependencyList { id: string; title: string; items: readonly DependencyItem[] }
interface Node { list: DependencyList; item: DependencyItem }
const key = (node: Node): string => `${node.list.id}#${node.item.number}`;

/** Resolves against the whole vault, including closed/archived lists, never just the visible page. */
export class TodoDependencies {
  readonly nodes: Node[];
  readonly #ids = new Map<string, Node[]>();

  constructor(lists: readonly DependencyList[]) {
    this.nodes = lists.flatMap(list => list.items.map(item => ({ list, item })));
    for (const node of this.nodes) if (node.item.id !== undefined) {
      const matches = this.#ids.get(node.item.id) ?? [];
      matches.push(node);
      this.#ids.set(node.item.id, matches);
    }
  }

  find(listId: string, number: number): Node | undefined {
    return this.nodes.find(node => node.list.id === listId && node.item.number === number);
  }

  unique(id: string): boolean { return this.#ids.get(id)?.length === 1; }

  #next(node: Node): Node[] {
    return (node.item.dependsOn ?? []).flatMap(id => this.#ids.get(id) ?? []);
  }

  /** Whether target already reaches source. Iterative so a long chain cannot exhaust the JS stack. */
  wouldCycle(source: Node, target: Node): boolean {
    const pending = [target];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (key(node) === key(source)) return true;
      if (seen.has(key(node))) continue;
      seen.add(key(node));
      pending.push(...this.#next(node));
    }
    return false;
  }

  cycle(node: Node): string[] {
    const stack = [{ node, next: this.#next(node), cursor: 0 }];
    const active = new Map([[key(node), 0]]);
    const visited = new Set<string>();
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.next[frame.cursor++];
      if (next === undefined) {
        active.delete(key(frame.node));
        visited.add(key(frame.node));
        stack.pop();
        continue;
      }
      const start = active.get(key(next));
      if (start !== undefined) return [...stack.slice(start).map(entry => entry.node.item.title), next.item.title];
      if (visited.has(key(next))) continue;
      active.set(key(next), stack.length);
      stack.push({ node: next, next: this.#next(next), cursor: 0 });
    }
    return [];
  }

  #view(node: Node): TodoDependencyView {
    return { id: node.item.id ?? null, listId: node.list.id, listTitle: node.list.title, item: node.item.number, title: node.item.title, status: node.item.status, issue: null };
  }

  enrich(listId: string, view: TodoItemView): TodoItemView {
    const node = this.find(listId, view.number);
    if (node === undefined) return view;
    const prerequisites: TodoDependencyView[] = (node.item.dependsOn ?? []).map(id => {
      const matches = this.#ids.get(id) ?? [];
      return matches.length === 1 ? this.#view(matches[0]!) : {
        id, listId: null, listTitle: null, item: null, status: null,
        title: node.item.dependencyTitles?.[id] ?? `事项 ${id}`,
        issue: matches.length === 0 ? "missing" : "ambiguous",
      };
    });
    const dependents = node.item.id === undefined || !this.unique(node.item.id) ? [] : this.nodes
      .filter(other => other.item.dependsOn?.includes(node.item.id!))
      .map(other => this.#view(other));
    return {
      ...view, prerequisites, dependents,
      unmetPrerequisites: prerequisites.filter(item => item.status !== "done" || item.issue !== null),
      dependencyCycle: this.cycle(node),
    };
  }
}
