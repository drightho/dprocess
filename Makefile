.PHONY: build test run vet clean

build:
	go build -o dprocess ./cmd/dprocess

test:
	go vet ./...
	go test ./...

run:
	go run ./cmd/dprocess

clean:
	rm -f dprocess dprocess.db dprocess.db-shm dprocess.db-wal
