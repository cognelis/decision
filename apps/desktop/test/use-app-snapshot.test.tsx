// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import type { AppSnapshot } from "../src/shared/renderer-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SNAPSHOT_LOAD_ERROR,
  useAppSnapshot,
  type AppSnapshotApi,
} from "../src/renderer/use-app-snapshot.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const snapshotFixture = (surface: AppSnapshot["primarySurface"]): AppSnapshot =>
  ({ primarySurface: surface }) as AppSnapshot;

const apiFixture = (requests: Array<Promise<AppSnapshot>>) => {
  let listener: ((snapshot: AppSnapshot) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const api: AppSnapshotApi = {
    getSnapshot: vi.fn(() => {
      const request = requests.shift();
      if (request === undefined) {
        return Promise.reject(new Error("Unexpected snapshot request"));
      }
      return request;
    }),
    onSnapshot: vi.fn((received) => {
      listener = received;
      return unsubscribe;
    }),
  };
  return {
    api,
    emit: (snapshot: AppSnapshot) => listener?.(snapshot),
    unsubscribe,
  };
};

afterEach(cleanup);

describe("useAppSnapshot", () => {
  it("loads the initial snapshot through one subscription", async () => {
    const initial = snapshotFixture("dashboard");
    const fixture = apiFixture([Promise.resolve(initial)]);

    const { result } = renderHook(() => useAppSnapshot(fixture.api));

    await waitFor(() => expect(result.current.snapshot).toBe(initial));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fixture.api.onSnapshot).toHaveBeenCalledOnce();
  });

  it("recovers an initial failure through retry without resubscribing", async () => {
    const first = deferred<AppSnapshot>();
    const second = deferred<AppSnapshot>();
    const recovered = snapshotFixture("dashboard");
    const fixture = apiFixture([first.promise, second.promise]);
    const { result } = renderHook(() => useAppSnapshot(fixture.api));

    await act(async () => {
      first.reject(new Error("private /vault path"));
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({
      snapshot: null,
      loading: false,
      error: SNAPSHOT_LOAD_ERROR,
    });

    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe(SNAPSHOT_LOAD_ERROR);

    await act(async () => {
      second.resolve(recovered);
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({
      snapshot: recovered,
      loading: false,
      error: null,
    });
    expect(fixture.api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.api.onSnapshot).toHaveBeenCalledOnce();
  });

  it("lets a pushed snapshot recover an initial failure", async () => {
    const first = deferred<AppSnapshot>();
    const pushed = snapshotFixture("settings");
    const fixture = apiFixture([first.promise]);
    const { result } = renderHook(() => useAppSnapshot(fixture.api));

    await act(async () => {
      first.reject(new Error("unavailable"));
      await Promise.resolve();
    });
    act(() => fixture.emit(pushed));

    expect(result.current).toMatchObject({
      snapshot: pushed,
      loading: false,
      error: null,
    });
  });

  it("does not let an older request overwrite a pushed snapshot", async () => {
    const pending = deferred<AppSnapshot>();
    const older = snapshotFixture("settings");
    const newer = snapshotFixture("dashboard");
    const fixture = apiFixture([pending.promise]);
    const { result } = renderHook(() => useAppSnapshot(fixture.api));

    act(() => fixture.emit(newer));
    await act(async () => {
      pending.resolve(older);
      await Promise.resolve();
    });

    expect(result.current.snapshot).toBe(newer);
  });

  it("unsubscribes and ignores an in-flight result after unmount", async () => {
    const pending = deferred<AppSnapshot>();
    const fixture = apiFixture([pending.promise]);
    const rendered = renderHook(() => useAppSnapshot(fixture.api));

    rendered.unmount();
    await act(async () => {
      pending.resolve(snapshotFixture("dashboard"));
      await Promise.resolve();
    });

    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(rendered.result.current.snapshot).toBeNull();
  });
});
