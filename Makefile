.PHONY: all build run dev docker-up docker-down frontend install-tools test clean

# Default target: start postgres + backend + frontend
all: docker-db frontend-install run

# Start only the PostgreSQL container
docker-db:
	docker compose up -d postgres
	@echo "Waiting for PostgreSQL to be ready..."
	@until docker compose exec postgres pg_isready -U stockwise -d stockwise_db > /dev/null 2>&1; do sleep 1; done
	@echo "PostgreSQL ready."

# Install Go dependencies
deps:
	go mod tidy
	go mod download

# Build the Go binary
build:
	go build -o bin/stockwise ./cmd/main.go

# Run the backend (assumes DB is up)
run: build
	./bin/stockwise

# Run backend in dev mode with live reload (requires air: go install github.com/air-verse/air@latest)
dev:
	air -c .air.toml

# Install frontend deps
frontend-install:
	cd frontend && npm install

# Build frontend for production
frontend-build:
	cd frontend && npm run build

# Start frontend dev server
frontend-dev:
	cd frontend && npm run dev

# Full local setup: DB + backend + frontend dev
local: docker-db
	@echo "Starting backend..."
	$(MAKE) build
	./bin/stockwise &
	@echo "Starting frontend..."
	cd frontend && npm run dev &
	@echo "App running at http://localhost:5173 (frontend) and http://localhost:8080 (API)"

# Start all with Docker
docker-up:
	cd frontend && npm run build
	docker compose up --build -d

docker-down:
	docker compose down

test:
	go test ./... -v -race

clean:
	rm -rf bin/
	docker compose down -v
