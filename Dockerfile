FROM golang:1.27-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/corvex ./cmd/corvex

FROM alpine:3.22

RUN apk add --no-cache ca-certificates \
    && addgroup -S corvex && adduser -S -G corvex corvex \
    && mkdir -p /data/corvex/state \
    && chown -R corvex:corvex /data/corvex
COPY --from=builder /out/corvex /usr/local/bin/corvex

USER corvex:corvex
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/corvex"]
CMD ["--config", "/etc/corvex/config.yaml", "server"]
