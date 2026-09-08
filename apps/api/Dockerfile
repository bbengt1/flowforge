# syntax=docker/dockerfile:1

FROM golang:1.22-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local

RUN apk add --no-cache ca-certificates git

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM alpine:3.20
RUN addgroup -S -g 65532 app && adduser -S -u 65532 -G app app \
 && apk add --no-cache ca-certificates tzdata

COPY --from=build --chown=65532:65532 /out/api /usr/local/bin/api
COPY --from=build --chown=65532:65532 /out/migrate /usr/local/bin/migrate

USER 65532:65532
EXPOSE 8080
# CMD (not ENTRYPOINT) so compose `command:` can run /usr/local/bin/migrate.
CMD ["/usr/local/bin/api"]
