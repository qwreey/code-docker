// Single source of truth for the 프로세스 table's columns.
//
// `.process-flex-table` (see Processes.css's own doc comment near
// `.pf-col-*`) turns <tr> into a flex row so ProcessTable.tsx's CSS `order`
// trick can visually re-sort rows without React moving DOM nodes (see
// commit a40f363). The unavoidable cost of that is that <table>'s native
// column-width algorithm no longer applies once <tr> stops being a real
// table row - every column's width has to come from an explicit
// `.pf-col-*` flex-basis class, applied identically to the header <th> (in
// ProcessTable.tsx) and every body <td> (in ProcessRowCells, ProcessRow.tsx).
//
// Before this file existed, both sites hand-duplicated that class string
// (plus label/sort-key/etc.) independently, and one column (`table-actions-col`
// on the actions column, see common.css) had already drifted - added to the
// body <td> in commit e5deb7b but never the header <th>. This module is the
// fix: both ProcessTable.tsx and ProcessRow.tsx now render from
// `COLUMN_ORDER`/`PROCESS_COLUMNS` instead of keeping their own copies.
//
// `PROCESS_COLUMNS` is typed as `Record<ColumnId, ProcessColumnDef>` rather
// than a plain array specifically so this can't silently drift again: if a
// new id is added to the `ColumnId` union below, TypeScript refuses to
// compile this object literal until it's given an entry here, and
// `ProcessRowCells` (see ProcessRow.tsx) builds its own `Record<ColumnId,
// ReactNode>` of cell content, which TypeScript will likewise refuse to
// compile if a column's content is missing - a column literally cannot be
// added on one side and forgotten on the other without a compile error.
export type SortKey = 'pid' | 'name' | 'username' | 'status' | 'cpuPercent' | 'memPercent' | 'rssBytes'

export type ColumnId = SortKey | 'cmd' | 'actions'

export interface ProcessColumnDef {
  /** Header text. For the actions column this is a non-breaking space, not
   *  empty, so the header cell still occupies its flex box (matches the
   *  original hand-written `<th>&nbsp;</th>`). */
  label: string
  /** `.pf-col-*` flex-basis class from Processes.css - the actual fix this
   *  module exists for: identical on <th> and <td>, always. */
  className: string
  /** Extra class applied to *both* header and body cells (e.g.
   *  `table-actions-col`, which common.css's own doc comment says belongs
   *  on both). Kept distinct from `bodyOnlyClassName` below because not
   *  every extra class makes sense on the header too. */
  sharedExtraClassName?: string
  /** Extra class applied to the body <td> only (e.g. `process-cmdline`'s
   *  ellipsis/truncation styling, which is about the cmdline *value*, not
   *  the header label). */
  bodyOnlyClassName?: string
  /** Static header tooltip (e.g. MEM's cgroup-vs-host explanation). Distinct
   *  from a body cell's own per-row title (process name/cmdline), which is
   *  computed per-row in ProcessRow.tsx instead of coming from here. */
  title?: string
  /** aria-label for a header cell with no meaningful visible label
   *  (currently just the actions column). */
  ariaLabel?: string
  /** Present only for columns the list view lets you sort by; drives the
   *  `sortable-header` button rendering in ProcessTable.tsx. */
  sortKey?: SortKey
}

export const PROCESS_COLUMNS: Record<ColumnId, ProcessColumnDef> = {
  pid: { label: 'PID', className: 'pf-col-pid', sortKey: 'pid' },
  name: { label: '이름', className: 'pf-col-name', sortKey: 'name' },
  username: { label: '사용자', className: 'pf-col-user', sortKey: 'username' },
  status: { label: '상태', className: 'pf-col-status', sortKey: 'status' },
  cpuPercent: { label: 'CPU', className: 'pf-col-cpu', sortKey: 'cpuPercent' },
  memPercent: {
    label: 'MEM',
    className: 'pf-col-mem',
    sortKey: 'memPercent',
    title: '컨테이너 메모리 제한(cgroup)이 설정된 경우 그 제한 대비 비율, 없으면 호스트 전체 메모리 대비 비율',
  },
  rssBytes: { label: 'RSS', className: 'pf-col-rss', sortKey: 'rssBytes' },
  cmd: { label: '커맨드', className: 'pf-col-cmd', bodyOnlyClassName: 'process-cmdline' },
  actions: {
    // U+00A0 (non-breaking space), not a plain space - matches the
    // original hand-written `<th>&nbsp;</th>`. A plain space in a JSX
    // text node is still ordinary collapsible HTML whitespace and can
    // render as nothing at all; U+00A0 never collapses.
    label: ' ',
    className: 'pf-col-actions',
    sharedExtraClassName: 'table-actions-col',
    ariaLabel: '동작',
  },
}

// Render order for the header row and every body row. `Object.keys()` on an
// object literal keyed by plain string identifiers is guaranteed by the JS
// spec to preserve insertion order, so this always matches the declaration
// order of `PROCESS_COLUMNS` above without needing to be kept in sync by hand.
export const COLUMN_ORDER = Object.keys(PROCESS_COLUMNS) as ColumnId[]

// Combines a column's shared class with the caller's own extra class
// (`sharedExtraClassName` for header+body, `bodyOnlyClassName` for body
// only) - used by both ProcessTable.tsx and ProcessRow.tsx so the class
// string is assembled identically on both sides.
export function columnClassName(col: ProcessColumnDef, extra?: string): string {
  return [col.className, col.sharedExtraClassName, extra].filter(Boolean).join(' ')
}
