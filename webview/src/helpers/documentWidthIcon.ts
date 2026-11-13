import type { IconNode } from 'lucide';

// Fluent Arrow Autofit Width adapted for 16px menus; see THIRD_PARTY_NOTICES.md.
// Fill more of the icon box and use the neighboring icons' rounded stroke weight.
export const DocumentWidth: IconNode = [
  ['path', { d: 'M4 10.5V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5.5' }],
  ['path', { d: 'M9.5 18H2m4-4-4 4 4 4' }],
  ['path', { d: 'M14.5 18H22m-4-4 4 4-4 4' }]
];
