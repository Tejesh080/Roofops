export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading project" className="stack">
      <div className="sk" style={{ width: 90, height: 14 }} />
      <div className="sk" style={{ width: 320, height: 34 }} />
      <div className="sk" style={{ width: 260, height: 16 }} />
      <div className="sk" style={{ height: 72, borderRadius: 14 }} />
      <div className="grid g-3">{[0, 1, 2].map((i) => <div key={i} className="sk" style={{ height: 190, borderRadius: 14 }} />)}</div>
      <div className="grid g-2">{[0, 1].map((i) => <div key={i} className="sk" style={{ height: 300, borderRadius: 14 }} />)}</div>
    </div>
  );
}
