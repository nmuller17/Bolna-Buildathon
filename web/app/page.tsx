// Root page: says where the two screens are, so http://127.0.0.1:PORT/ no longer answers 404.
// It holds no secret: the staff sign-in link is printed only in the server's terminal (SRV-10).
export const metadata = { title: "SignBridge" };

const box: React.CSSProperties = {
  maxWidth: 640,
  margin: "0 auto",
  padding: "48px 16px",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 17,
  lineHeight: 1.5,
  color: "#142235",
};

export default function Home() {
  return (
    <main style={{ background: "#ffffff", minHeight: "100dvh" }}>
      <div style={box}>
        <p style={{ fontWeight: 800, letterSpacing: "0.04em", color: "#0e2a47" }}>SignBridge</p>
        <h1 style={{ fontSize: 28, margin: "8px 0 16px" }}>Front-desk communication aid</h1>
        <ol style={{ paddingLeft: 22 }}>
          <li>
            <strong>Staff screen:</strong> open the one-time link that <code>scripts/demo.sh</code> (or <code>node server.mjs</code>) printed
            in its terminal. It looks like <code>http://127.0.0.1:PORT/staff#k=…</code>. Opening <a href="/staff">/staff</a> without it
            works only on a laptop that is already signed in.
          </li>
          <li>
            <strong>Guest screen:</strong> on the staff screen, tap <em>Start desk</em>, then <em>New guest</em>, then <em>Open guest window</em>,
            and drag that window to the display facing the guest.
          </li>
        </ol>
        <p style={{ color: "#4a5868" }}>
          Lost the staff link? In another terminal run <code>kill -USR2 &lt;server pid&gt;</code> to print a new one.
        </p>
      </div>
    </main>
  );
}
