.PHONY: build test lint typecheck run init config-check deploy deploy-worker

build:
	pnpm run build

test:
	pnpm test

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

run:
	pnpm start -- --config configs/config.yaml server

init: build
	pnpm start -- init --config configs/config.yaml

config-check: build
	pnpm start -- --config configs/config.yaml check-config

deploy:
	docker compose --env-file .env -f deploy/compose.yaml pull corvex
	docker compose --env-file .env -f deploy/compose.yaml up -d

deploy-worker:
	docker compose --env-file .env -f deploy/compose.yaml --profile worker pull
	docker compose --env-file .env -f deploy/compose.yaml --profile worker up -d
