export default function CasesPage() {
  return (
    <>
      <header className="header">
        <h1>Autonomous Buyer OS</h1>
        <nav aria-label="Primary">
          <a href="/cases" aria-current="page">
            Checkouts
          </a>
        </nav>
        <span className="budget">purchase budget: not configured</span>
        <span className="budget">metering allowance: not configured</span>
      </header>
      <main id="main">
        <h2 className="sr-only">Checkouts</h2>
        <p className="empty">
          No checkouts yet. Run the simulator once the seeded demo is available.
        </p>
        <p>
          <a href="/api/health">health</a>
        </p>
      </main>
    </>
  );
}
