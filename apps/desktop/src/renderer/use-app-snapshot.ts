import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AppSnapshot,
  DecisionApi,
} from "../shared/renderer-api.js";

export const SNAPSHOT_LOAD_ERROR = "暂时无法读取应用状态，请重试。";

export type AppSnapshotApi = Pick<
  DecisionApi,
  "getSnapshot" | "onSnapshot"
>;

export interface AppSnapshotState {
  snapshot: AppSnapshot | null;
  loading: boolean;
  error: string | null;
  retry(): void;
}

interface SnapshotValue {
  snapshot: AppSnapshot | null;
  loading: boolean;
  error: string | null;
}

const initialValue = (): SnapshotValue => ({
  snapshot: null,
  loading: true,
  error: null,
});

export const useAppSnapshot = (api: AppSnapshotApi): AppSnapshotState => {
  const [value, setValue] = useState<SnapshotValue>(initialValue);
  const active = useRef(false);
  const sequence = useRef(0);

  const settle = useCallback(
    (requestId: number, request: Promise<AppSnapshot>): void => {
      void request.then(
        (snapshot) => {
          if (!active.current || sequence.current !== requestId) return;
          setValue({ snapshot, loading: false, error: null });
        },
        () => {
          if (!active.current || sequence.current !== requestId) return;
          setValue((current) => ({
            ...current,
            loading: false,
            error: SNAPSHOT_LOAD_ERROR,
          }));
        },
      );
    },
    [],
  );

  useEffect(() => {
    active.current = true;
    const requestId = sequence.current + 1;
    sequence.current = requestId;
    setValue(initialValue());
    const request = Promise.resolve().then(() => api.getSnapshot());
    const unsubscribe = api.onSnapshot((snapshot) => {
      if (!active.current) return;
      sequence.current += 1;
      setValue({ snapshot, loading: false, error: null });
    });
    settle(requestId, request);

    return () => {
      active.current = false;
      sequence.current += 1;
      unsubscribe();
    };
  }, [api, settle]);

  const retry = useCallback((): void => {
    if (!active.current) return;
    const requestId = sequence.current + 1;
    sequence.current = requestId;
    setValue((current) => ({ ...current, loading: true }));
    settle(
      requestId,
      Promise.resolve().then(() => api.getSnapshot()),
    );
  }, [api, settle]);

  return { ...value, retry };
};
