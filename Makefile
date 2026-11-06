.PHONY: build web test web-test check gen-api check-api run dev-web clean

# Full build: web UI first, then the Go binary with the UI embedded.
build: web
	go build -o dprocess ./cmd/dprocess

# Build the web UI into web/dist (embedded by the Go binary).
web: web/node_modules
	cd web && npm run build

web/node_modules: web/package-lock.json
	cd web && npm ci
	touch web/node_modules

# Go checks only.
test:
	go vet ./...
	go test ./...

# Frontend typecheck and unit tests.
web-test: web/node_modules
	cd web && npm run typecheck && npm test

# Everything: Go and frontend checks.
check: test web-test check-api

# Regenerate the TypeScript types from api/openapi.yaml.
gen-api: web/node_modules
	cd web && npm run gen:api

# Fail if the committed generated types are out of date with the spec.
check-api: gen-api
	git diff --exit-code -- web/src/api/schema.d.ts

run:
	go run ./cmd/dprocess

# Vite dev server with hot reload; proxies /api to a server on 127.0.0.1:8080.
dev-web: web/node_modules
	cd web && npm run dev

clean:
	rm -f dprocess dprocess.db dprocess.db-shm dprocess.db-wal
