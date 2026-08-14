import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  reload?: () => void;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Decision renderer failed", error, info);
  }

  #reload = (): void => {
    const reload = this.props.reload ?? (() => window.location.reload());
    reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <section
        className="app-recovery-state"
        role="alert"
        aria-labelledby="app-render-error-title"
        aria-describedby="app-render-error-description"
      >
        <h1 id="app-render-error-title">应用界面发生错误</h1>
        <p id="app-render-error-description">
          当前界面无法继续显示，重新加载后可继续使用。
        </p>
        <button
          className="primary-button"
          type="button"
          onClick={this.#reload}
        >
          重新加载
        </button>
      </section>
    );
  }
}
