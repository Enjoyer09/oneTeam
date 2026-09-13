import { useEffect, useRef } from 'react';

/**
 * Modal əlçatanlığı — bir yerdə, bütün modallar üçün.
 *
 * Nə edir:
 *  1. Escape düyməsi modalı bağlayır (istifadəçi həmişə çıxış yolu görür).
 *  2. Tab / Shift+Tab fokusu modalın İÇİNDƏ saxlayır — klaviatura
 *     istifadəçisi arxa fondakı düymələrə "düşmür" (WCAG 2.4.3).
 *  3. Modal açılarkən fokus içinə keçir, bağlananda əvvəlki elementə qayıdır
 *     (istifadəçi harada idi, orada qalır).
 *
 * İstifadə:
 *   const modalRef = useModalA11y<HTMLDivElement>(isOpen, () => setOpen(false));
 *   <div className="glass-pop" ref={modalRef} role="dialog" aria-modal="true">
 */
export function useModalA11y<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);

  // onClose hər render-də dəyişə bilər (inline arrow). Onu ref-də saxlayırıq ki,
  // effekt yenidən işə düşüb fokusu təkrar-təkrar sıfırlamasın.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    const node = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] => {
      if (!node) return [];
      const sel =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
        'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return [...node.querySelectorAll<HTMLElement>(sel)].filter(
        (el) => el.offsetParent !== null && el.getAttribute('aria-hidden') !== 'true'
      );
    };

    // Fokusu modalın içinə sal — ilk uyğun element (adətən bağlama düyməsi)
    const first = focusables()[0];
    if (first) first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const list = focusables();
      if (list.length === 0) return;

      const idx = list.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement;
      if (e.shiftKey) {
        next = idx <= 0 ? list[list.length - 1] : list[idx - 1];
      } else {
        next = idx === -1 || idx === list.length - 1 ? list[0] : list[idx + 1];
      }
      e.preventDefault();
      next.focus();
    };

    // capture: faza — modal daxilindəki başqa handler-lərdən əvvəl işləyir
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Fokusu geri qaytar, amma element hələ də görünürsə
      if (previouslyFocused && previouslyFocused.offsetParent !== null) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  return ref;
}
