.PHONY: build test lint run

build:
	go build -trimpath -o corvex ./cmd/corvex

test:
	go test ./...

lint:
	go vet ./...

run:
	go run ./cmd/corvex --config configs/config.yaml server
