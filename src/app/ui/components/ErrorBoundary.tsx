import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Copy } from "../i18n.js";

interface Props {
  copy: Copy;
  children: ReactNode;
}

interface State {
  message?: string;
}

/** 渲染兜底：组件抛错时展示错误与重新加载入口，而不是整页空白。 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("operations console render failed", { error, componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.message === undefined) return this.props.children;
    return (
      <div className="error" role="alert">
        <strong>{this.props.copy.renderErrorTitle}</strong>
        <p>{this.props.copy.renderErrorDescription}</p>
        <pre className="details-content">{this.state.message}</pre>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          {this.props.copy.reloadPage}
        </button>
      </div>
    );
  }
}
