from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from typing import List

app = FastAPI(
    title="Dynamic Token & Waiting-Time Estimation System",
    version="5.0.0"
)

# --------------------------------------------------
# CORS
# --------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------
# DATABASE
# --------------------------------------------------

DATABASE_URL = "postgresql+psycopg2://manu@localhost:5432/smart_queue"

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
)

# --------------------------------------------------
# SERVICE DURATIONS
# --------------------------------------------------

SERVICE_DURATIONS = {
    "General Service": 7,
    "Document Verification": 10,
    "Payment Service": 5,
    "Enquiry": 4,
}

# --------------------------------------------------
# WEBSOCKET CONNECTION MANAGER
# --------------------------------------------------

class ConnectionManager:

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

        print(
            f"WebSocket connected. "
            f"Active connections: {len(self.active_connections)}"
        )

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

        print(
            f"WebSocket disconnected. "
            f"Active connections: {len(self.active_connections)}"
        )

    async def broadcast(self, message: str):

        disconnected = []

        for websocket in self.active_connections:
            try:
                await websocket.send_text(message)
            except Exception:
                disconnected.append(websocket)

        for websocket in disconnected:
            self.disconnect(websocket)


manager = ConnectionManager()

# --------------------------------------------------
# REQUEST MODEL
# --------------------------------------------------

class TokenRequest(BaseModel):
    customer_name: str
    service: str


# --------------------------------------------------
# RECALCULATE WAITING TIMES
# --------------------------------------------------

def recalculate_waiting_times(connection):

    result = connection.execute(
        text("""
            SELECT id, service_duration
            FROM tokens
            WHERE status = 'waiting'
            ORDER BY id ASC
        """)
    )

    tokens = result.fetchall()

    accumulated_wait = 0

    for token in tokens:

        connection.execute(
            text("""
                UPDATE tokens
                SET estimated_wait = :wait
                WHERE id = :id
            """),
            {
                "wait": accumulated_wait,
                "id": token.id,
            },
        )

        accumulated_wait += token.service_duration


# --------------------------------------------------
# GET QUEUE
# --------------------------------------------------

def get_queue_data():

    with engine.begin() as connection:

        result = connection.execute(
            text("""
                SELECT
                    id,
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status,
                    created_at
                FROM tokens
                ORDER BY id ASC
            """)
        )

        return [
            dict(row._mapping)
            for row in result.fetchall()
        ]


# --------------------------------------------------
# ROOT
# --------------------------------------------------

@app.get("/")
def root():

    return {
        "message": "Dynamic Token & Waiting-Time Estimation System API",
        "status": "running",
        "version": "5.0.0",
    }


# --------------------------------------------------
# HEALTH
# --------------------------------------------------

@app.get("/health")
def health():

    try:

        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))

        return {
            "status": "healthy",
            "database": "connected",
            "websocket": "enabled",
        }

    except Exception as error:

        return {
            "status": "unhealthy",
            "database": str(error),
            "websocket": "enabled",
        }


# --------------------------------------------------
# GET ALL TOKENS
# --------------------------------------------------

@app.get("/tokens")
def get_tokens():

    return get_queue_data()


# --------------------------------------------------
# GET SINGLE TOKEN
# --------------------------------------------------

@app.get("/tokens/{token_number}")
def get_token(token_number: str):

    with engine.connect() as connection:

        result = connection.execute(
            text("""
                SELECT
                    id,
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status,
                    created_at
                FROM tokens
                WHERE token_number = :token_number
            """),
            {
                "token_number": token_number
            },
        )

        token = result.fetchone()

        if not token:
            raise HTTPException(
                status_code=404,
                detail="Token not found"
            )

        return dict(token._mapping)


# --------------------------------------------------
# CREATE TOKEN
# --------------------------------------------------

@app.post("/tokens")
async def create_token(request: TokenRequest):

    if not request.customer_name.strip():
        raise HTTPException(
            status_code=400,
            detail="Customer name is required"
        )

    if request.service not in SERVICE_DURATIONS:
        raise HTTPException(
            status_code=400,
            detail="Invalid service"
        )

    duration = SERVICE_DURATIONS[request.service]

    with engine.begin() as connection:

        # Find next token number
        result = connection.execute(
            text("""
                SELECT token_number
                FROM tokens
                ORDER BY id DESC
                LIMIT 1
            """)
        )

        last_token = result.fetchone()

        if last_token:
            last_number = int(
                last_token.token_number.split("-")[1]
            )

            next_number = last_number + 1

        else:
            next_number = 101

        token_number = f"A-{next_number}"

        # Insert token
        result = connection.execute(
            text("""
                INSERT INTO tokens (
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status
                )
                VALUES (
                    :token_number,
                    :customer_name,
                    :service,
                    :duration,
                    0,
                    'waiting'
                )
                RETURNING
                    id,
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status,
                    created_at
            """),
            {
                "token_number": token_number,
                "customer_name": request.customer_name.strip(),
                "service": request.service,
                "duration": duration,
            },
        )

        token = result.fetchone()

        recalculate_waiting_times(connection)

        # Fetch updated token
        result = connection.execute(
            text("""
                SELECT
                    id,
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status,
                    created_at
                FROM tokens
                WHERE id = :id
            """),
            {
                "id": token.id
            },
        )

        updated_token = result.fetchone()

    await manager.broadcast("QUEUE_UPDATED")

    return dict(updated_token._mapping)


# --------------------------------------------------
# SERVE TOKEN
# --------------------------------------------------

@app.put("/tokens/{token_number}/serve")
async def serve_token(token_number: str):

    with engine.begin() as connection:

        result = connection.execute(
            text("""
                UPDATE tokens
                SET
                    status = 'serving',
                    estimated_wait = 0
                WHERE token_number = :token_number
                  AND status = 'waiting'
                RETURNING
                    id,
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status,
                    created_at
            """),
            {
                "token_number": token_number
            },
        )

        token = result.fetchone()

        if not token:
            raise HTTPException(
                status_code=404,
                detail="Waiting token not found"
            )

        recalculate_waiting_times(connection)

    await manager.broadcast("QUEUE_UPDATED")

    return dict(token._mapping)


# --------------------------------------------------
# COMPLETE TOKEN
# --------------------------------------------------

@app.put("/tokens/{token_number}/complete")
async def complete_token(token_number: str):

    with engine.begin() as connection:

        result = connection.execute(
            text("""
                UPDATE tokens
                SET
                    status = 'completed',
                    estimated_wait = 0
                WHERE token_number = :token_number
                  AND status = 'serving'
                RETURNING
                    id,
                    token_number,
                    customer_name,
                    service,
                    service_duration,
                    estimated_wait,
                    status,
                    created_at
            """),
            {
                "token_number": token_number
            },
        )

        token = result.fetchone()

        if not token:
            raise HTTPException(
                status_code=404,
                detail="Serving token not found"
            )

        recalculate_waiting_times(connection)

    await manager.broadcast("QUEUE_UPDATED")

    return dict(token._mapping)


# --------------------------------------------------
# WEBSOCKET
# --------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):

    print("WebSocket connection attempt received")

    try:

        await manager.connect(websocket)

        await websocket.send_text("CONNECTED")

        while True:

            message = await websocket.receive_text()

            print(
                f"WebSocket message received: {message}"
            )

    except WebSocketDisconnect:

        manager.disconnect(websocket)

        print("WebSocket client disconnected")

    except Exception as error:

        print(
            f"WebSocket error: {error}"
        )

    