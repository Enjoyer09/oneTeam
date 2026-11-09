import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Bütün tətbiqi əhatə edən React sərhədi. Render zamanı yaranan gözlənilməz
 * xəta interfeysi tamamilə boş ("ağ ekran") buraxmasın deyə, neytral və
 * tema-uyğun bir geri-dönüş ekranı göstərir. İstifadəçi "Yenidən yüklə" ilə
 * səhifəni təzələyə bilir.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Diaqnostika üçün konsola yazılır; xarici servis inteqrasiyası sonra əlavə oluna bilər.
    console.error('ErrorBoundary tutdu:', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--g-bg)]">
        <div className="glass-card w-full max-w-md rounded-card p-6 text-center flex flex-col items-center gap-3">
          <span
            className="grid h-12 w-12 place-items-center rounded-[14px]"
            style={{ backgroundColor: 'var(--warn-bg)', color: 'var(--warn)' }}
          >
            <AlertTriangle className="w-6 h-6" strokeWidth={1.9} />
          </span>
          <h1 className="text-[17px] font-extrabold tracking-[-.02em] text-ink">
            Gözlənilməz xəta baş verdi
          </h1>
          <p className="max-w-[42ch] text-[14px] leading-relaxed text-muted">
            Tətbiqdə gözlənilməz bir problem yarandı. Səhifəni yenidən yükləməklə davam edə
            bilərsiniz. Problem təkrarlanarsa, dəstək komandası ilə əlaqə saxlayın.
          </p>
          <button type="button" onClick={this.handleReload} className="btn-g mt-1">
            <RotateCcw className="w-3.5 h-3.5" strokeWidth={2.2} />
            Yenidən yüklə
          </button>
        </div>
      </div>
    );
  }
}
