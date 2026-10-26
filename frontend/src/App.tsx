
import { useCallback, useEffect, useState } from "react";
import "./index.css";

type QueueToken = {
  id: string;
  token_number: string;
  customer_name: string;
  service: string;
  service_duration: number;
  estimated_wait: number;
  status: "waiting" | "serving" | "completed";
  created_at?: string;
};

const API_URL = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/ws";

const services = [
  "General Service",
  "Document Verification",
  "Payment Service",
  "Enquiry",
];

function App() {
  const [queue, setQueue] = useState<QueueToken[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [service, setService] = useState(services[0]);
  const [generatedToken, setGeneratedToken] =
    useState<QueueToken | null>(null);
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "offline"
  >("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const loadQueue = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);

    try {
      const response = await fetch(`${API_URL}/tokens`);

      if (!response.ok) {
        throw new Error("The server could not load the queue.");
      }

      const data: QueueToken[] = await response.json();
      setQueue(data);
      setConnectionStatus("connected");
      setErrorMessage("");
    } catch {
      setConnectionStatus("offline");
      setErrorMessage(
        "Cannot reach the backend. Make sure your Node.js server is running on port 8000."
      );
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue(true);

    const refreshInterval = window.setInterval(() => {
      void loadQueue();
    }, 10000);

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connectSocket = () => {
      if (disposed) return;

      try {
        socket = new WebSocket(WS_URL);

        socket.onopen = () => {
          if (!disposed) setConnectionStatus("connected");
        };

        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as {
              type?: string;
            };

            if (message.type === "QUEUE_UPDATED") {
              void loadQueue();
            }
          } catch {
            // Ignore invalid WebSocket messages.
          }
        };

        socket.onclose = () => {
          if (!disposed) {
            reconnectTimer = window.setTimeout(connectSocket, 3000);
          }
        };

        socket.onerror = () => {
          socket?.close();
        };
      } catch {
        if (!disposed) {
          reconnectTimer = window.setTimeout(connectSocket, 3000);
        }
      }
    };

    connectSocket();

    return () => {
      disposed = true;
      window.clearInterval(refreshInterval);

      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }

      socket?.close();
    };
  }, [loadQueue]);

  const waitingTokens = queue.filter(
    (token) => token.status === "waiting"
  );
  const servingTokens = queue.filter(
    (token) => token.status === "serving"
  );
  const completedTokens = queue.filter(
    (token) => token.status === "completed"
  );

  const averageServiceTime = queue.length
    ? Math.round(
        queue.reduce(
          (sum, token) => sum + token.service_duration,
          0
        ) / queue.length
      )
    : 0;

  const nowServing = servingTokens[0] ?? null;
  const nextToken = waitingTokens[0]?.token_number ?? "—";

  const filteredTokens = queue.filter((token) => {
    const matchesSearch =
      token.token_number.toLowerCase().includes(search.toLowerCase()) ||
      token.customer_name.toLowerCase().includes(search.toLowerCase()) ||
      token.service.toLowerCase().includes(search.toLowerCase());

    const matchesStatus =
      statusFilter === "all" || token.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const generateToken = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!customerName.trim()) {
      setErrorMessage("Please enter the customer's name.");
      return;
    }

    setGenerating(true);
    setErrorMessage("");
    setGeneratedToken(null);

    try {
      const response = await fetch(`${API_URL}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: customerName.trim(),
          service,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Token generation failed.");
      }

      setGeneratedToken(result as QueueToken);
      setCustomerName("");
      await loadQueue();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not generate a token."
      );
    } finally {
      setGenerating(false);
    }
  };

  const updateToken = async (
    tokenNumber: string,
    action: "serve" | "complete"
  ) => {
    setBusyToken(tokenNumber);
    setErrorMessage("");

    try {
      const response = await fetch(
        `${API_URL}/tokens/${encodeURIComponent(tokenNumber)}/${action}`,
        { method: "PUT" }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || `Could not ${action} this token.`
        );
      }

      await loadQueue();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `Could not ${action} token.`
      );
    } finally {
      setBusyToken(null);
    }
  };

  const serveToken = (tokenNumber: string) =>
    updateToken(tokenNumber, "serve");

  const completeToken = (tokenNumber: string) =>
    updateToken(tokenNumber, "complete");

  const formatWait = (minutes: number) => {
    if (minutes <= 0) return "Next";
    return `${minutes} min`;
  };

  const statusLabel = (status: QueueToken["status"]) => {
    if (status === "serving") return "Serving";
    if (status === "completed") return "Completed";
    return "Waiting";
  };

  return (
    <div className="app">
      <div
        role="status"
        style={{
          padding: "8px 24px",
          fontSize: 13,
          color:
            connectionStatus === "connected"
              ? "#4ade80"
              : connectionStatus === "offline"
                ? "#f87171"
                : "#fbbf24",
        }}
      >
        {connectionStatus === "connected"
          ? "● LIVE SYSTEM CONNECTED"
          : connectionStatus === "offline"
            ? "● SERVER DISCONNECTED"
            : "● CONNECTING TO SERVER"}
      </div>

      <header className="hero">
        <div className="hero-content">
          <div className="eyebrow">
            <span className="eyebrow-dot" />
            REAL-TIME QUEUE MANAGEMENT
          </div>
          <h1>
            Smart Queue<span className="accent">.</span>
          </h1>
          <p>
            Smarter waiting. Better service. Live queue intelligence.
          </p>
        </div>
        <div className="hero-badge">
          <span className="hero-badge-icon">◈</span>
          <div>
            <strong>SMART QUEUE</strong>
            <small>Token &amp; Wait-Time System</small>
          </div>
        </div>
      </header>

      <main className="dashboard">
        {errorMessage && (
          <div
            role="alert"
            style={{
              padding: 14,
              marginBottom: 18,
              border: "1px solid #ef444455",
              borderRadius: 12,
              color: "#fca5a5",
              background: "#7f1d1d22",
            }}
          >
            {errorMessage}
            <button
              type="button"
              onClick={() => void loadQueue(true)}
              style={{ marginLeft: 12 }}
            >
              Retry
            </button>
          </div>
        )}

        <section className="stats-grid">
          <article className="stat-card">
            <span className="stat-label">TOTAL TOKENS</span>
            <strong className="stat-value">{queue.length}</strong>
            <span className="stat-note">All recorded tokens</span>
          </article>

          <article className="stat-card">
            <span className="stat-label">WAITING</span>
            <strong className="stat-value">{waitingTokens.length}</strong>
            <span className="stat-note">In the queue</span>
          </article>

          <article className="stat-card">
            <span className="stat-label">NOW SERVING</span>
            <strong className="stat-value">
              {servingTokens.length}
            </strong>
            <span className="stat-note">
              {nowServing?.token_number ?? "No active token"}
            </span>
          </article>

          <article className="stat-card">
            <span className="stat-label">COMPLETED</span>
            <strong className="stat-value">
              {completedTokens.length}
            </strong>
            <span className="stat-note">Service finished</span>
          </article>
        </section>

        <section className="dashboard-grid">
          <article className="panel now-serving-panel">
            <div className="panel-heading">
              <div>
                <span className="section-kicker">CURRENT SERVICE</span>
                <h2>Now Serving</h2>
              </div>
              <span className="live-pill">
                <span className="live-dot" />
                LIVE
              </span>
            </div>

            {nowServing ? (
              <div className="serving-content">
                <div className="serving-token">
                  {nowServing.token_number}
                </div>
                <h3>{nowServing.customer_name}</h3>
                <p>{nowServing.service}</p>
                <div className="serving-meta">
                  <span>
                    ◷ {nowServing.service_duration} min service
                  </span>
                  <span>● Currently serving</span>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={busyToken === nowServing.token_number}
                  onClick={() => void completeToken(nowServing.token_number)}
                >
                  {busyToken === nowServing.token_number
                    ? "Updating..."
                    : "✓ Complete Service"}
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <span className="empty-icon">◷</span>
                <h3>No active service</h3>
                <p>Serve the next waiting token to begin.</p>
                {waitingTokens[0] && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busyToken === waitingTokens[0].token_number}
                    onClick={() =>
                      void serveToken(waitingTokens[0].token_number)
                    }
                  >
                    Serve {waitingTokens[0].token_number}
                  </button>
                )}
              </div>
            )}
          </article>

          <article className="panel token-form-panel">
            <div className="panel-heading">
              <div>
                <span className="section-kicker">CUSTOMER ENTRY</span>
                <h2>Get Your Token</h2>
              </div>
              <span className="form-icon">＋</span>
            </div>

            <form onSubmit={generateToken}>
              <label htmlFor="customer-name">Customer name</label>
              <input
                id="customer-name"
                type="text"
                placeholder="Enter full name"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                maxLength={80}
                required
              />

              <label htmlFor="service">Choose a service</label>
              <select
                id="service"
                value={service}
                onChange={(event) => setService(event.target.value)}
              >
                {services.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>

              <button
                className="primary-button generate-button"
                type="submit"
                disabled={generating || connectionStatus !== "connected"}
              >
                {generating ? "Generating token..." : "＋ Generate Token"}
              </button>
            </form>

            {generatedToken && (
              <div className="generated-token" role="status">
                <span className="section-kicker">TOKEN CREATED SUCCESSFULLY</span>
                <strong>{generatedToken.token_number}</strong>
                <span>{generatedToken.customer_name}</span>
                <span>
                  Estimated wait: {formatWait(generatedToken.estimated_wait)}
                </span>
              </div>
            )}
          </article>
        </section>

        <section className="panel queue-panel">
          <div className="panel-heading queue-heading">
            <div>
              <span className="section-kicker">REAL-TIME OPERATIONS</span>
              <h2>Live Queue</h2>
              <p className="panel-description">
                Tokens are loaded from MongoDB and refreshed automatically.
              </p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void loadQueue(true)}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "↻ Refresh"}
            </button>
          </div>

          <div className="queue-toolbar">
            <input
              type="search"
              aria-label="Search queue"
              placeholder="Search token, customer or service..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="waiting">Waiting</option>
              <option value="serving">Serving</option>
              <option value="completed">Completed</option>
            </select>
          </div>

          {loading ? (
            <div className="empty-state">
              <h3>Loading live queue...</h3>
            </div>
          ) : filteredTokens.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">⌕</span>
              <h3>No tokens found</h3>
              <p>Try another search or generate a new token.</p>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Customer</th>
                    <th>Service</th>
                    <th>Wait</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTokens.map((token) => (
                    <tr key={token.id}>
                      <td>
                        <strong className="table-token">
                          {token.token_number}
                        </strong>
                      </td>
                      <td>{token.customer_name}</td>
                      <td>
                        <div>{token.service}</div>
                        <small>{token.service_duration} min service</small>
                      </td>
                      <td>
                        {token.status === "completed"
                          ? "—"
                          : formatWait(token.estimated_wait)}
                      </td>
                      <td>
                        <span className={`status-badge ${token.status}`}>
                          <span className="status-dot" />
                          {statusLabel(token.status)}
                        </span>
                      </td>
                      <td>
                        {token.status === "waiting" ? (
                          <button
                            className="table-action"
                            type="button"
                            disabled={busyToken === token.token_number}
                            onClick={() => void serveToken(token.token_number)}
                          >
                            {busyToken === token.token_number
                              ? "Updating..."
                              : "Serve →"}
                          </button>
                        ) : token.status === "serving" ? (
                          <button
                            className="table-action"
                            type="button"
                            disabled={busyToken === token.token_number}
                            onClick={() =>
                              void completeToken(token.token_number)
                            }
                          >
                            {busyToken === token.token_number
                              ? "Updating..."
                              : "Complete ✓"}
                          </button>
                        ) : (
                          <span className="completed-label">Finished ✓</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="bottom-grid">
          <article className="panel next-token-panel">
            <span className="section-kicker">UP NEXT</span>
            <h2>Next in Line</h2>
            <div className="next-token-number">{nextToken}</div>
            <p>
              {waitingTokens.length
                ? `${waitingTokens.length} customer(s) waiting`
                : "No customers waiting"}
            </p>
          </article>

          <article className="panel average-panel">
            <span className="section-kicker">SERVICE METRICS</span>
            <h2>Average Service Duration</h2>
            <div className="average-value">
              {averageServiceTime}
              <span> min</span>
            </div>
            <p>Average across recorded tokens</p>
          </article>

          <article className="panel system-panel">
            <span className="section-kicker">SYSTEM STATUS</span>
            <h2>Live Connectivity</h2>
            <div className="system-row">
              <span>REST API</span>
              <strong className={connectionStatus}>
                {connectionStatus === "connected" ? "Connected" : connectionStatus}
              </strong>
            </div>
            <div className="system-row">
              <span>WebSocket</span>
              <strong className={connectionStatus}>
                {connectionStatus === "connected" ? "Enabled" : "Reconnecting"}
              </strong>
            </div>
            <div className="system-row">
              <span>Database data</span>
              <strong>MongoDB</strong>
            </div>
          </article>
        </section>

        <footer className="app-footer">
          <span>SMART QUEUE · DYNAMIC TOKEN MANAGEMENT</span>
          <span>React • Node.js • Express • MongoDB • WebSocket</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
