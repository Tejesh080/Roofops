'use client';

import { useState } from 'react';
import type { ProjectRow } from '@/lib/queries';
import { ProjectTable, type TableFilter } from './ProjectTable';

export function ProjectsView({ rows, initial }: { rows: ProjectRow[]; initial: TableFilter }) {
  const [filter, setFilter] = useState<TableFilter>(initial);
  return <ProjectTable rows={rows} filter={filter} onFilter={setFilter} title="All projects" />;
}
