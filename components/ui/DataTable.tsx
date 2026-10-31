import type { ReactNode, Ref } from 'react'

export type Column<T> = { key: string; header: string; headerClassName?: string; cellClassName?: string; cell: (row: T) => ReactNode }

// Table accessible (extraite de /leaderboard) : caption lue aux lecteurs d'écran et focalisable (captionRef), en-têtes scope="col",
// `current` : la ligne du lecteur (aria-current). Aucun tri : un tri viendra avec ses boutons d'en-tête.
export function DataTable<T>({ caption, captionRef, columns, rows, rowKey, current }: {
  caption: string
  captionRef?: Ref<HTMLTableCaptionElement>
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  current?: (row: T) => boolean
}) {
  return (
    <div className="card-frame">
      <table className="w-full table-fixed text-left text-sm">
        <caption ref={captionRef} tabIndex={-1} className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-[var(--color-border)]">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-2 py-2 sm:px-3${c.headerClassName ? ` ${c.headerClassName}` : ''}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((row) => {
            const own = current?.(row) ?? false
            return (
              <tr key={rowKey(row)} aria-current={own ? 'true' : undefined} className={own ? 'bg-[var(--color-surface-light)] font-semibold' : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={`px-2 py-2 sm:px-3${c.cellClassName ? ` ${c.cellClassName}` : ''}`}>{c.cell(row)}</td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
