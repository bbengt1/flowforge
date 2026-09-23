package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/bbengt1/flowforge/apps/api/internal/kekrotate"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func main() {
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := kekrotate.Run(ctx, os.Args[1:], os.Stdout); err != nil {
		log.Error("kek-rotate", "error", err)
		os.Exit(1)
	}
}
