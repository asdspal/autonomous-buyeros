import MandateNewForm from './MandateNewForm';

export const metadata = { title: 'New mandate — Autonomous Buyer OS' };

export default function NewMandatePage() {
  return (
    <>
      <header className="header">
        <h1>Autonomous Buyer OS</h1>
        <nav aria-label="Primary">
          <a href="/cases">Checkouts</a>
        </nav>
      </header>
      <main id="main">
        <MandateNewForm />
      </main>
    </>
  );
}
