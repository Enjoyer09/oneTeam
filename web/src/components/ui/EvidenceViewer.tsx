import { useEffect, useRef, useState } from 'react';
import type { DetectionItem } from '../../types';

import { fitEvidence } from '../../lib/evidenceGeometry';

/** The image and detections share one plane, including at non-4:3 aspect ratios. */
export function EvidenceViewer({
  src,
  alt,
  detections = [],
}: {
  src?: string | null;
  alt: string;
  detections?: DetectionItem[];
}) {
  // Remount on a source change so old dimensions, errors and zoom never leak to the next photo.
  return <EvidenceImage key={src ?? 'missing'} src={src} alt={alt} detections={detections} />;
}
function EvidenceImage({
  src,
  alt,
  detections,
}: {
  src?: string | null;
  alt: string;
  detections: DetectionItem[];
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => setBounds({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [expanded, failed, src]);
  if (!src)
    return (
      <div className="rounded-xl border border-hair p-6 text-sm text-ink-2">
        Bu tapşırığa nümunə foto əlavə edilməyib.
      </div>
    );
  const fit = fitEvidence(natural.width, natural.height, bounds.width, bounds.height);
  const width = fit.width * zoom;
  const height = fit.height * zoom;
  const ready = natural.width > 0 && !failed;
  const showFullPhoto = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setZoom(1);
    setExpanded(true);
    if (failed) {
      setFailed(false);
      setNatural({ width: 0, height: 0 });
      setAttempt((value) => value + 1);
    }
  };
  return (
    <section aria-label={alt} className="min-w-0 rounded-xl border border-hair overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 p-2 bg-[var(--g-panel)]">
        <button
          type="button"
          className="btn-g min-h-[44px]"
          disabled={!ready || zoom <= 1}
          aria-label="Fotonu kiçilt"
          onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
        >
          −
        </button>
        <span className="text-sm text-ink tabular-nums" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="btn-g min-h-[44px]"
          disabled={!ready || zoom >= 4}
          aria-label="Fotonu böyüt"
          onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
        >
          +
        </button>
        <button
          type="button"
          className="btn-g min-h-[44px]"
          aria-expanded={expanded}
          onClick={showFullPhoto}
        >
          {expanded ? 'Yığcam görünüş' : 'Tam fotonu göstər'}
        </button>
      </div>
      {failed ? (
        <div role="alert" className="p-6 text-sm text-ink space-y-3">
          <p>Foto yüklənmədi. Bağlantını yoxlayıb yenidən cəhd edin.</p>
          <button
            type="button"
            className="btn-g"
            onClick={() => {
              setFailed(false);
              setNatural({ width: 0, height: 0 });
              setAttempt((value) => value + 1);
            }}
          >
            Fotonu yenidən yüklə
          </button>
        </div>
      ) : (
        <>
          {!ready ? (
            <p role="status" className="p-2 text-sm text-ink-2">
              Foto yüklənir…
            </p>
          ) : null}
          <div
            ref={viewport}
            tabIndex={0}
            role="region"
            aria-label={`${alt} — böyüdükdə sürüşdürün`}
            className="overflow-auto bg-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            style={{ height: expanded ? '70vh' : 360 }}
          >
            <div
              className="flex items-center justify-center"
              style={{
                width: Math.max(bounds.width, width),
                height: Math.max(bounds.height, height),
              }}
            >
              <div className="relative shrink-0" style={{ width, height }}>
                <img
                  key={attempt}
                  src={src}
                  alt={alt}
                  className="block w-full h-full"
                  onError={() => setFailed(true)}
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget;
                    if (!naturalWidth || !naturalHeight) {
                      setFailed(true);
                      return;
                    }
                    setNatural({ width: naturalWidth, height: naturalHeight });
                  }}
                />
                {ready &&
                  detections.map((det) => (
                    <div
                      key={det.id}
                      title={`${det.label} (${Math.round(det.confidence * 100)}%)`}
                      className="absolute border-2 pointer-events-none"
                      style={{
                        left: `${det.box.x}%`,
                        top: `${det.box.y}%`,
                        width: `${det.box.width}%`,
                        height: `${det.box.height}%`,
                        borderColor: det.color,
                        borderStyle: det.sku === 'out_of_stock_gap' ? 'dashed' : 'solid',
                      }}
                    >
                      <span className="inline-block max-w-full truncate bg-slate-950/90 text-white text-xs px-1">
                        {det.label}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
          <p className="p-2 text-xs text-muted">
            “Tam fotonu göstər” şəkli geniş açır. Böyüdülmüş fotonu sürüşdürərək yoxlayın.
          </p>
        </>
      )}
    </section>
  );
}
