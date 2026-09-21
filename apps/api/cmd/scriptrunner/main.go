// Command scriptrunner is the container entrypoint for one isolated
// script.python / script.go Job. It reads the published source from the
// environment, runs it, and writes the script's stdout unchanged.
// Failures print an error code only — never the source or the environment.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/bbengt1/flowforge/apps/api/internal/scriptrun"
)

func main() {
	if err := scriptrun.Run(context.Background(), os.Getenv, os.Stdout, os.Stderr); err != nil {
		if _, werr := fmt.Fprintf(os.Stderr, "script-runner: %s\n", scriptrun.Code(err)); werr != nil {
			os.Exit(1)
		}
		os.Exit(1)
	}
}
