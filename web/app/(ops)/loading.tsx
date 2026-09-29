export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="sk" style={{ width: 260, height: 32, marginBottom: 10 }} />
      <div className="sk" style={{ width: 340, height: 16, marginBottom: 24 }} />
      <div className="metrics" style={{ marginBottom: 16 }}>
        {Array.from({ length: 5 }, (_, i) => <div key={i} className="sk" style={{ height: 118, borderRadius: 14 }} />)}
      </div>
      <div className="sk" style={{ height: 220, borderRadius: 14, marginBottom: 16 }} />
      <div className="sk" style={{ height: 420, borderRadius: 14 }} />
    </div>
  );
}
