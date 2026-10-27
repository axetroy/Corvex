.PHONY: build test lint typecheck run

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
