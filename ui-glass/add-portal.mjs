/**
 * Modalları React portalına keçirir.
 * Hər əvəzləmə TAM BİR dəfə baş verməlidir — əks halda skript dayanır və
 * fayl yazılmır (səssiz pozulma olmasın).
 */
import fs from 'node:fs';

const DIR = '/Users/macbookair/GitHub/oneTeam/web/src/components';

function apply(file, rules) {
  const p = `${DIR}/${file}`;
  let src = fs.readFileSync(p, 'utf8');
  const log = [];

  for (const [from, to, label] of rules) {
    const hits = src.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`[${file}] "${label}" — 1 yerinə ${hits} uyğunluq tapıldı. Fayl yazılmadı.`);
    }
    src = src.split(from).join(to);
    log.push(`  ✓ ${label}`);
  }

  fs.writeFileSync(p, src, 'utf8');
  console.log(`\n═══ ${file} ═══\n${log.join('\n')}`);
}

const VEIL_OPEN =
  '<div className="fixed inset-0 z-50 modal-veil flex items-center justify-center p-4 sm:p-6 overflow-y-auto">';

/* ── AuditReviewCenter ─────────────────────────────────────────────────── */
apply('AuditReviewCenter.tsx', [
  [
    "import React, { useState } from 'react';",
    "import React, { useState } from 'react';\nimport { ModalPortal } from './ui/ModalPortal';",
    'portal importu',
  ],
  [
    `      {selectedSubmission && (\n        ${VEIL_OPEN}`,
    `      {selectedSubmission && (\n        <ModalPortal>\n        ${VEIL_OPEN}`,
    'modal açılışı',
  ],
  [
    `        </div>\n      )}\n    </div>\n  );\n};`,
    `        </div>\n        </ModalPortal>\n      )}\n    </div>\n  );\n};`,
    'modal bağlanışı',
  ],
]);

/* ── TaskManager (iki modal) ───────────────────────────────────────────── */
apply('TaskManager.tsx', [
  [
    "import React, { useState } from 'react';",
    "import React, { useState } from 'react';\nimport { ModalPortal } from './ui/ModalPortal';",
    'portal importu',
  ],
  [
    `      {isBulkModalOpen && (\n        ${VEIL_OPEN}`,
    `      {isBulkModalOpen && (\n        <ModalPortal>\n        ${VEIL_OPEN}`,
    'kütləvi modal açılışı',
  ],
  [
    `        </div>\n      )}\n\n      {/* ====================================================================== */}\n      {/* CREATE NEW TASK MODAL */}`,
    `        </div>\n        </ModalPortal>\n      )}\n\n      {/* ====================================================================== */}\n      {/* CREATE NEW TASK MODAL */}`,
    'kütləvi modal bağlanışı',
  ],
  [
    `      {isCreateModalOpen && (\n        ${VEIL_OPEN}`,
    `      {isCreateModalOpen && (\n        <ModalPortal>\n        ${VEIL_OPEN}`,
    'yaratma modalı açılışı',
  ],
  [
    `        </div>\n      )}\n    </div>\n  );\n};`,
    `        </div>\n        </ModalPortal>\n      )}\n    </div>\n  );\n};`,
    'yaratma modalı bağlanışı',
  ],
]);

console.log('\nBütün modallar portal üzərinə keçirildi.');
