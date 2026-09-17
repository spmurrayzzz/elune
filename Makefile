.PHONY: run build

run: build
	cd backend && ./elune

build:
	cd frontend && npm ci && npm run build
	cd backend && go build -o elune .
