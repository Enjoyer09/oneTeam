import { createPortal } from 'react-dom';
import React from 'react';

/**
 * ModalPortal — modalı birbaşa <body>-nin altına render edir.
 *
 * NİYƏ LAZIMDIR:
 * Modallar əvvəl `main > .view-g` ağacının içində idi. `.view-g` giriş
 * animasiyası `transform` animasiya edir; `animation-fill-mode: both` səbəbindən
 * brauzer onu həmişəlik "transform-u var" kimi qəbul edir və `position: fixed`
 * üçün yeni "containing block" yaradır. Nəticədə modal pərdəsi ekranı yox,
 * yalnız məzmun sahəsini örtürdü: yan panel qaralmırdı və pərdədən kənar
 * sahələr kliklənə bilirdi.
 *
 * Portal bu asılılığı tamamilə kəsir — modal `<body>` altında render olunur,
 * ona görə heç bir əcdad transform/filter onu təsirləndirmir.
 */
export const ModalPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
};
