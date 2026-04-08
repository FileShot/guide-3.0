/**
 * ErrorBoundary — Catches React render errors and displays a recovery UI.
 * Wraps the entire app to prevent white-screen crashes.
 */
import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // Log to console for debugging
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRecover = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen w-screen bg-[#0a0a0a] text-white">
          <div className="max-w-lg mx-auto text-center p-8">
            <AlertTriangle size={48} className="mx-auto mb-4 text-yellow-400" />
            <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
            <p className="text-gray-400 mb-6 text-sm">
              An unexpected error occurred. You can try recovering or reload the page.
            </p>

            {this.state.error && (
              <pre className="bg-[#1a1a1a] border border-[#333] rounded p-3 text-left text-xs text-red-400 mb-6 overflow-auto max-h-40">
                {this.state.error.toString()}
                {this.state.errorInfo?.componentStack && (
                  <span className="text-gray-500">{this.state.errorInfo.componentStack}</span>
                )}
              </pre>
            )}

            <div className="flex gap-3 justify-center">
              <button
                className="px-4 py-2 bg-[#333] hover:bg-[#444] rounded text-sm transition-colors"
                onClick={this.handleRecover}
              >
                Try to Recover
              </button>
              <button
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors flex items-center gap-2"
                onClick={this.handleReload}
              >
                <RefreshCw size={14} />
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
