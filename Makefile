.PHONY: build test lint typecheck run init config-check deploy deploy-worker

build:
	npm run build

test:
	npm test

lint:
	npm run lint

typecheck:
	npm run typecheck

run:
	npm start -- --config configs/config.yaml server

init: build
	npm start -- init --config configs/config.yaml

config-check: build
	npm start -- --config configs/config.yaml check-config

deploy:
	docker compose --env-file .env -f deploy/compose.yaml pull corvex
	docker compose --env-file .env -f deploy/compose.yaml up -d

deploy-worker:
	docker compose --env-file .env -f deploy/compose.yaml --profile worker pull
	docker compose --env-file .env -f deploy/compose.yaml --profile worker up -d
