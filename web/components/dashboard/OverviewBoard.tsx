'use client';

import { useState } from 'react';
import type { ProjectRow } from '@/lib/queries';
import { Metrics, type Metric } from './Metrics';
import { ProjectTable, type TableFilter } from './ProjectTable';

/** Metric cards and the project table share one filter; the URL keeps it shareable without reloading. */
export function OverviewBoard({ rows, metrics, initial, attention }: { rows: ProjectRow[]; metrics: Metric[]; initial: TableFilter; attention: React.ReactNode }) {
  const [filter, setFilter] = useState<TableFilter>(initial);
  const select = (f: TableFilter) => {
    setFilter(f);
    const url = new URL(window.location.href);
    if (f === 'active') url.searchParams.delete('view'); else url.searchParams.set('view', f);
    window.history.replaceState(null, '', url);
  };
  return (
    <div className="stack">
      <Metrics items={metrics} selected={filter} onSelect={select} />
      {attention}
      <ProjectTable rows={rows} filter={filter} onFilter={select} />
    </div>
  );
}

